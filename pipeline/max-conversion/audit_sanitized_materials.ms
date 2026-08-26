/*
  Read-only material audit for an already sanitized 3ds Max scene.
  The script writes to a fresh evidence path and never deletes or overwrites files.
*/

fn ctEscape value =
(
    local text = value as string
    text = substituteString text "\\" "\\\\"
    text = substituteString text "\t" " "
    text = substituteString text "\r" " "
    text = substituteString text "\n" " "
    text
)

fn ctClassName value =
(
    try ((classOf value) as string) catch "<class-error>"
)

fn ctPropertyText value =
(
    local valueClass = classOf value
    if valueClass == String or valueClass == Filename or valueClass == Name then
        (ctEscape value)
    else
        undefined
)

fn ctWalkTexmap texmapValue path stream visited =
(
    if texmapValue == undefined then return false
    if (findItem visited texmapValue) != 0 then
    (
        format "TEXMAP-REF\t%\t%\t%\n" (ctEscape path) (ctEscape texmapValue.name) (ctClassName texmapValue) to:stream
        return true
    )
    append visited texmapValue
    format "TEXMAP\t%\t%\t%\n" (ctEscape path) (ctEscape texmapValue.name) (ctClassName texmapValue) to:stream

    local propertyNames = #()
    try (propertyNames = getPropNames texmapValue) catch ()
    for propertyName in propertyNames do
    (
        local propertyValue = undefined
        try (propertyValue = getProperty texmapValue propertyName) catch ()
        local propertyText = if propertyValue == undefined then undefined else ctPropertyText propertyValue
        if propertyText != undefined and propertyText != "" do
            format "TEXMAP-PROPERTY\t%\t%\t%\n" (ctEscape path) (ctEscape propertyName) propertyText to:stream
    )

    local subTexmapCount = 0
    try (subTexmapCount = getNumSubTexmaps texmapValue) catch ()
    for index = 1 to subTexmapCount do
    (
        local child = undefined
        local slotName = "slot-" + (index as string)
        try (child = getSubTexmap texmapValue index) catch ()
        try (slotName = getSubTexmapSlotName texmapValue index) catch ()
        if child != undefined do ctWalkTexmap child (path + "/" + slotName) stream visited
    )
    true
)

fn ctWalkMaterial materialValue path stream visitedMaterials visitedTexmaps =
(
    if materialValue == undefined then return false
    if (findItem visitedMaterials materialValue) != 0 then
    (
        format "MATERIAL-REF\t%\t%\t%\n" (ctEscape path) (ctEscape materialValue.name) (ctClassName materialValue) to:stream
        return true
    )
    append visitedMaterials materialValue
    format "MATERIAL\t%\t%\t%\n" (ctEscape path) (ctEscape materialValue.name) (ctClassName materialValue) to:stream

    local propertyNames = #()
    try (propertyNames = getPropNames materialValue) catch ()
    for propertyName in propertyNames do
    (
        local propertyValue = undefined
        try (propertyValue = getProperty materialValue propertyName) catch ()
        local propertyText = if propertyValue == undefined then undefined else ctPropertyText propertyValue
        if propertyText != undefined and propertyText != "" do
            format "MATERIAL-PROPERTY\t%\t%\t%\n" (ctEscape path) (ctEscape propertyName) propertyText to:stream
    )

    local subTexmapCount = 0
    try (subTexmapCount = getNumSubTexmaps materialValue) catch ()
    for index = 1 to subTexmapCount do
    (
        local texmapValue = undefined
        local slotName = "slot-" + (index as string)
        try (texmapValue = getSubTexmap materialValue index) catch ()
        try (slotName = getSubTexmapSlotName materialValue index) catch ()
        if texmapValue != undefined do ctWalkTexmap texmapValue (path + "/" + slotName) stream visitedTexmaps
    )

    local subMaterialCount = 0
    try (subMaterialCount = getNumSubMtls materialValue) catch ()
    for index = 1 to subMaterialCount do
    (
        local childMaterial = undefined
        local slotName = "submaterial-" + (index as string)
        try (childMaterial = getSubMtl materialValue index) catch ()
        try (slotName = getSubMtlSlotName materialValue index) catch ()
        if childMaterial != undefined do ctWalkMaterial childMaterial (path + "/" + slotName) stream visitedMaterials visitedTexmaps
    )
    true
)

scenePath = systemTools.getEnvVariable "CT_SANITIZED_SCENE"
outputPath = systemTools.getEnvVariable "CT_AUDIT_OUTPUT"

try
(
    if scenePath == undefined or outputPath == undefined or scenePath == "" or outputPath == "" do throw "Missing CT_SANITIZED_SCENE or CT_AUDIT_OUTPUT."
    if not doesFileExist scenePath do throw ("Sanitized scene is missing: " + scenePath)
    if doesFileExist outputPath do throw ("Audit output already exists: " + outputPath)
    if not (loadMaxFile scenePath useFileUnits:true quiet:true) do throw "loadMaxFile returned false."

    local stream = createFile outputPath
    format "AUDIT\tsanitized-material-bindings-v1\t%\n" (ctEscape scenePath) to:stream
    format "SCENE\tobjects\t%\n" objects.count to:stream
    format "SCENE\tmaterials\t%\n" sceneMaterials.count to:stream

    local visitedMaterials = #()
    local visitedTexmaps = #()
    for materialValue in sceneMaterials do
        ctWalkMaterial materialValue ("sceneMaterials/" + materialValue.name) stream visitedMaterials visitedTexmaps

    for node in objects do
    (
        local materialName = if node.material == undefined then "<none>" else node.material.name
        local materialClass = if node.material == undefined then "<none>" else ctClassName node.material
        format "NODE-MATERIAL\t%\t%\t%\n" (ctEscape node.name) (ctEscape materialName) materialClass to:stream
    )

    local assetFiles = #()
    try (ATSOps.GetFiles &assetFiles) catch ()
    for assetFile in assetFiles do format "ASSET\t%\n" (ctEscape assetFile) to:stream

    format "SUMMARY\tmaterialsVisited\t%\n" visitedMaterials.count to:stream
    format "SUMMARY\ttexmapsVisited\t%\n" visitedTexmaps.count to:stream
    format "STATUS\tsuccess\n" to:stream
    close stream
)
catch errorMessage
(
    if outputPath != undefined and outputPath != "" and not doesFileExist outputPath then
    (
        local stream = createFile outputPath
        format "STATUS\tfailed\t%\n" (ctEscape errorMessage) to:stream
        close stream
    )
)
quitMax #noPrompt
