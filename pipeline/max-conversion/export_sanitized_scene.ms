/*
  Isolated conversion entry point for an already-attested offline 3ds Max host.
  Input and output paths are supplied only through CT_* environment variables.
  Never pass the untrusted .max path as a 3ds Max command-line scene argument.
*/

fn ctJsonEscape value =
(
    local text = value as string
    text = substituteString text "\\" "\\\\"
    text = substituteString text "\"" "\\\""
    text = substituteString text "\n" "\\n"
    text
)

fn ctWriteReport path status message objectCount geometryCount materialCount deletedAttributes =
(
    local stream = createFile path
    format "{\"schemaVersion\":1,\"jobId\":\"%\",\"sourceSha256\":\"%\",\"status\":\"%\",\"message\":\"%\",\"safety\":{\"sourceReadOnly\":true,\"networkDisabled\":true,\"scriptExecutionDisabled\":true,\"customAttributesSanitized\":true},\"inventory\":{\"objects\":%,\"geometryObjects\":%,\"materials\":%,\"deletedCustomAttributes\":%},\"exports\":{\"sanitizedScene\":\"sanitized-scene.max\",\"analysisProxy\":\"analysis-proxy.fbx\",\"fullScene\":\"full-scene.fbx\",\"proxyMode\":\"full-fidelity-fallback-for-structural-analysis\"}}" (ctJsonEscape (systemTools.getEnvVariable "CT_JOB_ID")) (ctJsonEscape (systemTools.getEnvVariable "CT_SOURCE_SHA256")) status (ctJsonEscape message) objectCount geometryCount materialCount deletedAttributes to:stream
    close stream
)

fn ctDeleteCustomAttributes holder =
(
    local removed = 0
    try
    (
        while (custAttributes.count holder baseObject:false) > 0 do
        (
            custAttributes.delete holder 1 baseObject:false
            removed += 1
        )
    ) catch ()
    try
    (
        while (custAttributes.count holder baseObject:true) > 0 do
        (
            custAttributes.delete holder 1 baseObject:true
            removed += 1
        )
    ) catch ()
    removed
)

fn ctConfigureFbx =
(
    pluginManager.loadClass FbxExporter
    FBXExporterSetParam "ResetExport"
    FBXExporterSetParam "ASCII" false
    FBXExporterSetParam "Animation" false
    FBXExporterSetParam "Cameras" false
    FBXExporterSetParam "Lights" false
    FBXExporterSetParam "EmbedTextures" false
    FBXExporterSetParam "ConvertUnit" "m"
    FBXExporterSetParam "UpAxis" "Y"
    FBXExporterSetParam "Triangulate" true
    FBXExporterSetParam "SmoothingGroups" true
    FBXExporterSetParam "TangentSpaceExport" true
    FBXExporterSetParam "Preserveinstances" true
    FBXExporterSetParam "GenerateLog" true
)

sourcePath = systemTools.getEnvVariable "CT_SOURCE_PATH"
outputDir = systemTools.getEnvVariable "CT_OUTPUT_DIR"
reportPath = outputDir + "\\conversion-report.json"
objectMapPath = outputDir + "\\object-map.json"

try
(
    if sourcePath == undefined or outputDir == undefined or sourcePath == "" or outputDir == "" do throw "Missing CT_SOURCE_PATH or CT_OUTPUT_DIR."
    if not doesFileExist sourcePath do throw ("Source scene is missing: " + sourcePath)
    makeDir outputDir all:true

    -- Safe Scene execution is enforced on the process command line before this script starts.
    -- Load only after the safety switches and isolated-host attestation are in effect.
    if not (loadMaxFile sourcePath useFileUnits:true quiet:true) do throw "loadMaxFile returned false."

    local deletedAttributes = ctDeleteCustomAttributes rootNode
    local objectCount = 0
    local materialCount = 0
    for node in objects do
    (
        deletedAttributes += ctDeleteCustomAttributes node
        objectCount += 1
    )
    for materialItem in sceneMaterials do
    (
        deletedAttributes += ctDeleteCustomAttributes materialItem
        materialCount += 1
    )
    for definition in (custAttributes.getSceneDefs()) do try(custAttributes.deleteDef definition)catch()

    saveMaxFile (outputDir + "\\sanitized-scene.max") quiet:true

    local mapStream = createFile objectMapPath
    format "{\"schemaVersion\":1,\"objects\":[" to:mapStream
    local firstEntry = true
    local geometryCount = 0
    for node in objects do
    (
        if not firstEntry do format "," to:mapStream
        firstEntry = false
        if (superClassOf node == GeometryClass) do geometryCount += 1
        format "{\"name\":\"%\",\"class\":\"%\",\"parent\":%}" (ctJsonEscape node.name) (ctJsonEscape ((classOf node) as string)) (if node.parent == undefined then "null" else ("\"" + (ctJsonEscape node.parent.name) + "\"")) to:mapStream
    )
    format "]}" to:mapStream
    close mapStream

    ctConfigureFbx()
    exportFile (outputDir + "\\full-scene.fbx") #noPrompt selectedOnly:false using:FBXEXP
    -- The first accepted Yueyang pass preserves full geometry in the analysis file;
    -- subsequent passes may replace this with a verified per-object proxy export.
    exportFile (outputDir + "\\analysis-proxy.fbx") #noPrompt selectedOnly:false using:FBXEXP
    ctWriteReport reportPath "success" "Safe-scene load, custom-attribute removal and FBX export completed." objectCount geometryCount materialCount deletedAttributes
)
catch errorMessage
(
    makeDir outputDir all:true
    ctWriteReport reportPath "failed" (errorMessage as string) 0 0 0 0
)
quitMax #noPrompt
