$body = @{
  message = "查一下今天上海天气怎么样"
  sessionId = "test-execution-001"
} | ConvertTo-Json -Compress
$body | Out-File -FilePath "d:\abc\EvoClaw\nouse\scripts\req-exec.json" -Encoding utf8
Write-Host "Body: $body"
