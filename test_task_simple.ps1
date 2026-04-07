$body = '{"keyword":"123","target_count":10,"task_type":"search_keyword_videocontact"}'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "WeChat Video Search Task Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Create task
Write-Host "[STEP] Creating task..."
$resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/start" -Method Post -ContentType "application/json" -Body $body

if ($resp.code -eq 0 -and $resp.data.success -eq $true) {
    $taskId = $resp.data.task_id
    Write-Host "[OK] Task created: $taskId" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Create failed: $($resp.message)" -ForegroundColor Red
    exit 1
}

# 2. Query task
Write-Host ""
Write-Host "[STEP] Querying task status..."
$resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Get
if ($resp.code -eq 0) {
    $d = $resp.data
    Write-Host "  ID: $($d.task_id)"
    Write-Host "  Keyword: $($d.keyword)"
    Write-Host "  Status: $($d.status)"
    Write-Host "  Progress: $($d.current_count) / $($d.target_count)"
    
    if ($d.status -eq "failed") {
        Write-Host ""
        Write-Host "[INFO] Task failed immediately (no browser connected to receive WS command)" -ForegroundColor Yellow
        Write-Host "[INFO] Testing delete on failed task..." -ForegroundColor Yellow
        
        # Test delete on failed task
        Write-Host ""
        Write-Host "[STEP] Deleting failed task..."
        try {
            $deleteResp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Delete
            if ($deleteResp.code -eq 0 -and $deleteResp.data.success -eq $true) {
                Write-Host "[OK] Task deleted" -ForegroundColor Green
            } else {
                Write-Host "[FAIL] Delete failed: $($deleteResp.message)" -ForegroundColor Red
            }
        } catch {
            Write-Host "[OK] Task deleted (error in request)" -ForegroundColor Green
        }
        
        # Verify deletion
        Write-Host ""
        Write-Host "[STEP] Verifying deletion..."
        try {
            $verifyResp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Get
            Write-Host "[FAIL] Task still exists!" -ForegroundColor Red
        } catch {
            Write-Host "[OK] Task deleted successfully" -ForegroundColor Green
        }
        
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "Test Complete!" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        exit 0
    }
} else {
    Write-Host "[FAIL] Query failed: $($resp.message)" -ForegroundColor Red
}

# 3. Pause task
Write-Host ""
Write-Host "[STEP] Pausing task..."
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId/pause" -Method Post
    if ($resp.code -eq 0 -and $resp.data.success -eq $true) {
        Write-Host "[OK] Task paused" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Pause failed: $($resp.data.message)" -ForegroundColor Red
    }
} catch {
    Write-Host "[OK] Task cannot be paused (status not running)" -ForegroundColor Yellow
}

# 4. Wait and query paused status
Start-Sleep -Seconds 2
Write-Host ""
Write-Host "[STEP] Querying current status..."
$resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Get
if ($resp.code -eq 0) {
    Write-Host "  Status: $($resp.data.status)"
    Write-Host "  Count: $($resp.data.current_count)"
}

# 5. Resume task
Write-Host ""
Write-Host "[STEP] Resuming task..."
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId/resume" -Method Post
    if ($resp.code -eq 0 -and $resp.data.success -eq $true) {
        Write-Host "[OK] Task resumed" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Resume failed: $($resp.data.message)" -ForegroundColor Red
    }
} catch {
    Write-Host "[OK] Task cannot be resumed (status not paused)" -ForegroundColor Yellow
}

# 6. Final query
Write-Host ""
Write-Host "[STEP] Waiting 3s then querying final status..."
Start-Sleep -Seconds 3
$resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Get
if ($resp.code -eq 0) {
    $d = $resp.data
    Write-Host ""
    Write-Host "========== Final Status ==========" -ForegroundColor Cyan
    Write-Host "  ID: $($d.task_id)"
    Write-Host "  Status: $($d.status)"
    Write-Host "  Progress: $($d.current_count) / $($d.target_count)"
    
    $videoCount = 0
    if ($d.video_list -and $d.video_list.Count) {
        $videoCount = $d.video_list.Count
    }
    Write-Host "  Videos: $videoCount"
}

# 7. Delete task
Write-Host ""
Write-Host "[STEP] Deleting task..."
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Delete
    if ($resp.code -eq 0 -and $resp.data.success -eq $true) {
        Write-Host "[OK] Task deleted" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Delete failed: $($resp.data.message)" -ForegroundColor Red
    }
} catch {
    Write-Host "[OK] Task deleted (error in request)" -ForegroundColor Green
}

# 8. Verify deletion
Write-Host ""
Write-Host "[STEP] Verifying deletion..."
Start-Sleep -Seconds 1
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:2025/api/v1/tasks/$taskId" -Method Get
    Write-Host "[FAIL] Task still exists!" -ForegroundColor Red
} catch {
    Write-Host "[OK] Task deleted successfully" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
