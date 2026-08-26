local outputPath = @"E:\Station\China_Tower\evidence\3d-assets\jobs\yueyang\outputs\max-preflight.txt"
local stream = createFile outputPath
format "isolated-maxscript-channel-ready" to:stream
close stream
quitMax #noPrompt
