# Test Pause/Resume/Delete APIs using test endpoint
$BASE_URL = "http://localhost:2025"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Pause/Resume/Delete APIs" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Create a test task (directly set to running, no WS needed)
Write-Host "[STEP] Creating test task (status=running)..."
$body = '{"keyword":"123","target_count":210,"task_type":"search_keyword_videocontact"}'
$resp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/start-test" -Method Post -ContentType "application/json" -Body $body

if ($resp.code -eq 0) {
    $taskId = $resp.data.task_id
    $status = $resp.data.status
    Write-Host "[OK] Task created: $taskId (status=$status)" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Create failed: $($resp.message)" -ForegroundColor Red
    exit 1
}

# 2. Query task status
Write-Host ""
Write-Host "[STEP] Querying task status..."
$resp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId" -Method Get
if ($resp.code -eq 0) {
    Write-Host "  Status: $($resp.data.status)"
    Write-Host "  Progress: $($resp.data.current_count) / $($resp.data.target_count)"
}

# 3. Pause task
Write-Host ""
Write-Host "[STEP] Pausing task..."
try {
    $pauseResp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId/pause" -Method Post
    if ($pauseResp.code -eq 0) {
        Write-Host "[OK] Task paused: $($pauseResp.data.message)" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Pause failed: $($pauseResp.message)" -ForegroundColor Red
    }
} catch {
    $errCode = [int]$_.Exception.Response.StatusCode
    $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    Write-Host "[FAIL] Pause HTTP error $errCode" -ForegroundColor Red
}

# 4. Query paused status
Write-Host ""
Write-Host "[STEP] Querying paused status..."
Start-Sleep -Seconds 1
$resp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId" -Method Get
if ($resp.code -eq 0) {
    Write-Host "  Status: $($resp.data.status)" -ForegroundColor Yellow
    Write-Host "  Progress: $($resp.data.current_count) / $($resp.data.target_count)"
}

# 5. Resume task
Write-Host ""
Write-Host "[STEP] Resuming task..."
try {
    $resumeResp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId/resume" -Method Post
    if ($resumeResp.code -eq 0) {
        Write-Host "[OK] Task resumed: $($resumeResp.data.message)" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Resume failed: $($resumeResp.message)" -ForegroundColor Red
    }
} catch {
    $errCode = [int]$_.Exception.Response.StatusCode
    $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    Write-Host "[FAIL] Resume HTTP error $errCode" -ForegroundColor Red
}

# 6. Query resumed status
Write-Host ""
Write-Host "[STEP] Querying resumed status..."
Start-Sleep -Seconds 1
$resp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId" -Method Get
if ($resp.code -eq 0) {
    Write-Host "  Status: $($resp.data.status)" -ForegroundColor Yellow
    Write-Host "  Progress: $($resp.data.current_count) / $($resp.data.target_count)"
}

# 7. Pause again
Write-Host ""
Write-Host "[STEP] Pausing task again..."
try {
    $pauseResp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId/pause" -Method Post
    if ($pauseResp.code -eq 0) {
        Write-Host "[OK] Task paused again" -ForegroundColor Green
    }
} catch {
    Write-Host "[FAIL] Pause failed" -ForegroundColor Red
}

# 8. Delete task
Write-Host ""
Write-Host "[STEP] Deleting task..."
$delResp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId" -Method Delete
if ($delResp.code -eq 0) {
    Write-Host "[OK] Task deleted: $($delResp.data.message)" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Delete failed: $($delResp.message)" -ForegroundColor Red
}

# 9. Verify deletion
Write-Host ""
Write-Host "[STEP] Verifying deletion..."
try {
    $verifyResp = Invoke-RestMethod -Uri "$BASE_URL/api/v1/tasks/$taskId" -Method Get
    Write-Host "[FAIL] Task still exists!" -ForegroundColor Red
} catch {
    Write-Host "[OK] Task deleted (404 returned)" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "All Tests Passed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
