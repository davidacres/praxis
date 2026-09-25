/// Tracks the highest event sequence applied, so a replay can resume after it.
class MobileEventCursor {
  MobileEventCursor([this._latest = 0]);

  int _latest;

  int get sequence => _latest;

  /// Records an envelope; false when it was already seen (a duplicate delivery).
  bool observe(num sequence) {
    if (!sequence.isFinite || sequence <= _latest) return false;
    _latest = sequence.toInt();
    return true;
  }

  void reset([int start = 0]) => _latest = start;
}
