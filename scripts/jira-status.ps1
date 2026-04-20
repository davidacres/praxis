param([Parameter(Mandatory=$true)][string]$Token, [Parameter(Mandatory=$true)][string]$Key)
$headers = @{ Authorization = "Bearer $Token"; Accept = "application/json" }
$r = Invoke-RestMethod -Uri "https://jira.example.com/rest/api/2/issue/$Key" -Headers $headers
Write-Output "status=$($r.fields.status.name)"
Write-Output "labels=$($r.fields.labels -join ',')"
Write-Output "updated=$($r.fields.updated)"
Write-Output "---TRANSITIONS---"
$t = Invoke-RestMethod -Uri "https://jira.example.com/rest/api/2/issue/$Key/transitions" -Headers $headers
$t.transitions | ForEach-Object { "{0}: {1} -> {2}" -f $_.id, $_.name, $_.to.name }
