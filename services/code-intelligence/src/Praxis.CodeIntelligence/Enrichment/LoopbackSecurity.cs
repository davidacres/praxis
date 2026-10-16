using System.Net;
using System.Net.Sockets;
using System.Security;

namespace Praxis.CodeIntelligence.Enrichment;

/// <summary>
/// Enforces §17 loopback security and privacy policy for local inference endpoints.
/// Strictly permits only validated loopback addresses (127.0.0.1, ::1, localhost),
/// rejects all external/remote addresses, and disables HTTP redirects and proxies.
/// </summary>
public static class LoopbackSecurity
{
    public static bool IsLoopbackUri(Uri uri)
    {
        if (uri is null) return false;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            return false;

        var host = uri.DnsSafeHost;
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
            return true;

        if (IPAddress.TryParse(host, out var ip))
            return IPAddress.IsLoopback(ip);

        try
        {
            var addresses = Dns.GetHostAddresses(host);
            return addresses.Length > 0 && addresses.All(IPAddress.IsLoopback);
        }
        catch
        {
            return false;
        }
    }

    public static void ValidateLoopbackUri(Uri uri)
    {
        if (uri is null) throw new ArgumentNullException(nameof(uri));
        if (!IsLoopbackUri(uri))
            throw new SecurityException($"Inference endpoint '{uri}' is rejected: §17 local privacy policy strictly permits only validated loopback addresses (127.0.0.1, ::1, localhost). External and non-loopback destinations are forbidden.");
    }

    public static SocketsHttpHandler CreateSecureLoopbackHandler()
    {
        return new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            ConnectTimeout = TimeSpan.FromSeconds(5)
        };
    }
}
