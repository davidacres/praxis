//! Telling a dropped model stream apart from the agent's own words.
//!
//! When Codex loses its connection to the model mid-reply it does not fail the ACP turn. It
//! writes the transport error into the reply text, as ordinary `agent_message_chunk`s, and then
//! ends the turn with `end_turn` — so without this the session reads "completed" and the
//! assistant bubble ends with raw rustls output glued onto the last sentence:
//!
//! ```text
//! …I'll extend the shared layout hooks.Warning: Falling back from WebSockets to HTTPS transport.
//! stream disconnected before completion: IO error: peer closed connection without sending TLS
//! close_notify: https://docs.rs/rustls/…#unexpected-eof
//!
//! stream disconnected before completion: Transport error: network error: error decoding response body
//! ```
//!
//! [`split_stream_disconnect`] recognises that tail and separates it from the prose before it,
//! so the host can keep the partial reply and fail the turn with a message a person can act on.
//!
//! It only matches a *tail made entirely of those error lines*. A reply that quotes the error
//! while explaining it (agents do, when asked "why did we get this?") has prose after the quote
//! and is left alone.

/// What a person is told when a turn ended because the model stream dropped.
pub const STREAM_DISCONNECT_NOTICE: &str = "The connection to the model dropped before the reply finished, so this turn did not complete. Anything above is the partial reply. Send a follow-up (for example \"continue\") to retry; the agent resumes from where it stopped.";

/// The prefix Codex prints when its WebSocket stream fails over to HTTPS.
const FALLBACK_WARNING: &str = "Warning: Falling back from WebSockets to HTTPS transport.";
/// The prefix Codex prints when a stream ends before the model finished.
const DISCONNECTED: &str = "stream disconnected before completion:";

/// A reply split into the agent's own words and the transport error that ended it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamDisconnect {
    /// The partial reply before the error, trimmed. May be empty.
    pub reply: String,
    /// The raw error lines, kept for diagnosis.
    pub detail: String,
}

/// True when every non-blank line of `tail` is one of the transport error lines and at least one
/// says the stream disconnected. The fallback warning on its own is not a failure: the HTTPS
/// retry may well have finished the reply.
fn is_error_tail(tail: &str) -> bool {
    let mut disconnected = false;
    for line in tail.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let rest = line.strip_prefix(FALLBACK_WARNING).map_or(line, str::trim_start);
        if rest.starts_with(DISCONNECTED) {
            disconnected = true;
        } else if !rest.is_empty() {
            return false;
        }
    }
    disconnected
}

/// Splits a reply that ends in a dropped-stream error. `None` when the reply has no such tail.
#[must_use]
pub fn split_stream_disconnect(reply: &str) -> Option<StreamDisconnect> {
    // The earliest marker whose remainder is pure error text; the error can start mid-line,
    // because Codex appends it straight after the last chunk with no separator.
    let starts = reply
        .match_indices(FALLBACK_WARNING)
        .chain(reply.match_indices(DISCONNECTED))
        .map(|(index, _)| index);
    let start = starts
        .filter(|&index| is_error_tail(&reply[index..]))
        .min()?;
    Some(StreamDisconnect {
        reply: reply[..start].trim_end().to_owned(),
        detail: reply[start..].trim().to_owned(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::split_stream_disconnect;

    /// Verbatim from a real Codex session in Praxis.
    const OBSERVED: &str = "I'll fix the composer's layout first.Warning: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: IO error: peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof\n\nstream disconnected before completion: Transport error: network error: error decoding response body\n\n";

    #[test]
    fn the_observed_codex_tail_is_split_from_the_prose() {
        let split = split_stream_disconnect(OBSERVED).unwrap();
        assert_eq!(split.reply, "I'll fix the composer's layout first.");
        assert!(split.detail.starts_with("Warning: Falling back"));
        assert!(split.detail.ends_with("error decoding response body"));
    }

    #[test]
    fn a_reply_that_is_only_the_error_leaves_no_prose() {
        let split = split_stream_disconnect(
            "stream disconnected before completion: Transport error: network error",
        )
        .unwrap();
        assert_eq!(split.reply, "");
    }

    #[test]
    fn a_reply_quoting_the_error_while_explaining_it_is_left_alone() {
        let reply = "You saw \"stream disconnected before completion: IO error\".\n\nThat means the connection dropped; retry the turn.";
        assert_eq!(split_stream_disconnect(reply), None);
    }

    #[test]
    fn the_fallback_warning_alone_is_not_a_disconnect_when_prose_follows() {
        let reply = "Warning: Falling back from WebSockets to HTTPS transport.\nHere is the full answer.";
        assert_eq!(split_stream_disconnect(reply), None);
    }

    #[test]
    fn a_trailing_fallback_warning_without_a_disconnect_is_left_alone() {
        let reply = "Partial answer.Warning: Falling back from WebSockets to HTTPS transport.";
        assert_eq!(split_stream_disconnect(reply), None);
    }

    #[test]
    fn an_ordinary_reply_is_left_alone() {
        assert_eq!(split_stream_disconnect("All done."), None);
        assert_eq!(split_stream_disconnect(""), None);
    }
}
