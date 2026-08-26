marker = @"E:\Station\China_Tower\evidence\3d-assets\jobs\yueyang\outputs\batch-preflight-marker.txt"
stream = createFile marker
format "isolated-batch-ready" to:stream
close stream
quitMax #noPrompt
