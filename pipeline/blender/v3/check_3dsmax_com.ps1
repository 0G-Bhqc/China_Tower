try {
    $max = New-Object -ComObject '3dsMax.Application'
    Write-Host 'COM_OK'
    $max.Quit()
} catch {
    Write-Host 'COM_FAILED'
    Write-Host $_
}
