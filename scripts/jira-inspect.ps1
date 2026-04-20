param(
    [Parameter(Mandatory=$true)][string]$Token,
    [Parameter(Mandatory=$true)][string]$Key,
    [int]$LastN = 8
)
$headers = @{ Authorization = "Bearer $Token"; Accept = "application/json" }
$r = Invoke-RestMethod -Uri "https://jira.example.com/rest/api/2/issue/$Key" -Headers $headers
Write-Output "=== $Key ==="
Write-Output "status=$($r.fields.status.name) labels=$($r.fields.labels -join ',') updated=$($r.fields.updated)"
Write-Output "attachments=$($r.fields.attachment.Count)"
foreach ($a in $r.fields.attachment) { Write-Output "  ATTACH: $($a.filename) ($($a.size) bytes, $($a.created))" }
Write-Output "comments=$($r.fields.comment.total)"
$r.fields.comment.comments | Select-Object -Last $LastN | ForEach-Object {
    Write-Output "---"
    Write-Output "[$($_.author.displayName) @ $($_.created)]"
    $body = $_.body
    if ($body.Length -gt 400) { $body = $body.Substring(0,400) + "..." }
    Write-Output $body
}
