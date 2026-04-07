$body = '{"keyword":"test_debug","target_count":10,"task_type":"search_keyword_videocontact"}'

Write-Host "Creating task..."
$resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/start" -Method Post -ContentType "application/json" -Body $body

Write-Host "Response:"
$resp | ConvertTo-Json -Depth 5 | Write-Host

Write-Host ""
Write-Host "Getting task..."
$taskId = $resp.data.task_id
Write-Host "Task ID: $taskId"

$getResp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Get
Write-Host "Get Response:"
$getResp | ConvertTo-Json -Depth 5 | Write-Host

# Delete
Write-Host ""
Write-Host "Deleting task..."
$delResp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Delete
Write-Host "Delete Response:"
$delResp | ConvertTo-Json -Depth 5 | Write-Host
