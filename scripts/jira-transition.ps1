param(
    [Parameter(Mandatory=$true)][string]$Token,
    [Parameter(Mandatory=$true)][string]$Key,
    [Parameter(Mandatory=$true)][string]$TransitionId
)
$headers = @{ Authorization = "Bearer $Token"; Accept = "application/json"; "Content-Type" = "application/json" }
$body = @{ transition = @{ id = $TransitionId } } | ConvertTo-Json
Invoke-RestMethod -Uri "https://jira.example.com/rest/api/2/issue/$Key/transitions" -Method POST -Headers $headers -Body $body
$r = Invoke-RestMethod -Uri "https://jira.example.com/rest/api/2/issue/$Key" -Headers $headers
Write-Output "status=$($r.fields.status.name)"
