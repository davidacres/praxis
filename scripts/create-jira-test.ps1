param(
    [Parameter(Mandatory = $true)][string]$Token
)
$headers = @{ Authorization = "Bearer $Token"; Accept = "application/json"; "Content-Type" = "application/json" }
$payload = @{
    fields = @{
        project     = @{ key = 'KAMAI' }
        summary     = 'AI bot e2e test - blue login page'
        description = "base branch: master`n`nChange the login page background colour to a mid blue hex code. Use the add-edit-blazor-component workflow."
        issuetype   = @{ name = 'Task' }
        priority    = @{ name = 'Minor' }
        labels      = @('syscfg')
    }
} | ConvertTo-Json -Depth 6
$r = Invoke-RestMethod -Uri "https://jira.example.com/rest/api/2/issue" -Method POST -Headers $headers -Body $payload
Write-Output "Created: $($r.key)"
