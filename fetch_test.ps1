try {
    $r = Invoke-WebRequest -Uri 'http://www.paoshu9.com/1_1789/' -UseBasicParsing -TimeoutSec 15 -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    Write-Host "STATUS: $($r.StatusCode)"
    Write-Host "LENGTH: $($r.Content.Length)"
    Write-Host "CONTENT_START:"
    Write-Host $r.Content.Substring(0, [Math]::Min(3000, $r.Content.Length))
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
}
