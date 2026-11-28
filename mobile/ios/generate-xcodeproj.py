#!/usr/bin/env python3
"""Generate mobile/ios/Lever.xcodeproj cleanly from mobile/ios/Lever sources."""

import base64
import hashlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

IOS_DIR = Path(__file__).resolve().parent
APP_DIR = IOS_DIR / "Lever"
PROJ_DIR = IOS_DIR / "Lever.xcodeproj"
SCHEMES_DIR = PROJ_DIR / "xcshareddata" / "xcschemes"


def uid(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:24].upper()


def copy_icon() -> None:
    src = IOS_DIR.parent / "icon.png"
    dst = APP_DIR / "Resources" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon.png"
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    preset_src = IOS_DIR.parent.parent / "cmd" / "lever-desktop" / "icon.png"
    if not preset_src.exists():
        preset_src = src
    preset_dst = APP_DIR / "Resources" / "Assets.xcassets" / "LeverPresetLogo.imageset" / "LeverPresetLogo.png"
    if preset_src.exists():
        preset_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(preset_src, preset_dst)
        contents = preset_dst.parent / "Contents.json"
        contents.write_text(
            '{\n'
            '  "images": [\n'
            '    {\n'
            '      "filename": "LeverPresetLogo.png",\n'
            '      "idiom": "universal"\n'
            '    }\n'
            '  ],\n'
            '  "info": {\n'
            '    "author": "xcode",\n'
            '    "version": 1\n'
            '  }\n'
            '}\n',
            encoding="utf-8",
        )
    sync_desktop_provider_icons()


def write_vector_imageset(assets_dir: Path, name: str, svg_text: str, template: bool) -> None:
    img_dir = assets_dir / f"{name}.imageset"
    img_dir.mkdir(parents=True, exist_ok=True)
    svg_path = img_dir / f"{name}.svg"
    if not svg_path.exists() or svg_path.read_text(encoding="utf-8") != svg_text:
        svg_path.write_text(svg_text, encoding="utf-8")
    intent = "template" if template else "original"
    contents = (
        '{\n'
        '  "images": [\n'
        '    {\n'
        f'      "filename": "{name}.svg",\n'
        '      "idiom": "universal"\n'
        '    }\n'
        '  ],\n'
        '  "info": {\n'
        '    "author": "xcode",\n'
        '    "version": 1\n'
        '  },\n'
        '  "properties": {\n'
        '    "preserves-vector-representation": true,\n'
        f'    "template-rendering-intent": "{intent}"\n'
        '  }\n'
        '}\n'
    )
    (img_dir / "Contents.json").write_text(contents, encoding="utf-8")


def render_svg_transparent_png(svg_markup: str, out_png: Path, size: int = 180) -> bool:
    """Render complex filter-based SVG (e.g. antigravity.svg Gaussian blur mesh) via macOS WKWebView with true alpha transparency."""
    b64 = base64.b64encode(svg_markup.encode("utf-8")).decode("ascii")
    html = (
        '<!doctype html><html><head><style>'
        'html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%;}'
        f'img{{display:block;width:{size}px;height:{size}px;}}'
        '</style></head>'
        f'<body><img src="data:image/svg+xml;base64,{b64}"/></body></html>'
    )
    swift_script = f'''
import AppKit
import WebKit

final class Renderer: NSObject, WKNavigationDelegate {{
    let webView: WKWebView
    let outPath: String
    let size: Int

    init(outPath: String, size: Int) {{
        self.outPath = outPath
        self.size = size
        let cfg = WKWebViewConfiguration()
        self.webView = WKWebView(frame: NSRect(x: 0, y: 0, width: size, height: size), configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
    }}

    func start(html: String) {{
        webView.loadHTMLString(html, baseURL: nil)
    }}

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {{
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {{
            let snapCfg = WKSnapshotConfiguration()
            snapCfg.rect = CGRect(x: 0, y: 0, width: self.size, height: self.size)
            snapCfg.snapshotWidth = NSNumber(value: self.size)
            webView.takeSnapshot(with: snapCfg) {{ image, err in
                if let image,
                   let tiff = image.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {{
                    try? png.write(to: URL(fileURLWithPath: self.outPath))
                    exit(0)
                }} else {{
                    fputs("snapshot failed: \\(String(describing: err))\\n", stderr)
                    exit(1)
                }}
            }}
        }}
    }}
}}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let renderer = Renderer(outPath: CommandLine.arguments[2], size: {size})
let html = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
renderer.start(html: html)
DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) {{ exit(2) }}
app.run()
'''
    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "render.html"
        swift_path = Path(tmp) / "render.swift"
        html_path.write_text(html, encoding="utf-8")
        swift_path.write_text(swift_script, encoding="utf-8")
        res = subprocess.run(
            ["swift", str(swift_path), str(html_path), str(out_png)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        return res.returncode == 0 and out_png.exists()


def sync_desktop_provider_icons() -> None:
    """Reuse Lever Desktop's exact RuntimeIcon.tsx SVG paths and antigravity.svg verbatim (zero hand-redrawing)."""
    repo_root = IOS_DIR.parent.parent
    runtime_tsx = repo_root / "web" / "src" / "components" / "RuntimeIcon.tsx"
    ag_svg = repo_root / "web" / "src" / "components" / "icons" / "antigravity.svg"
    assets_dir = APP_DIR / "Resources" / "Assets.xcassets"

    if runtime_tsx.exists():
        src = runtime_tsx.read_text(encoding="utf-8")

        def extract_entry(key: str) -> str:
            m = re.search(rf'\[\s*"{re.escape(key)}"\s*,(.*?)\],', src, re.S)
            if not m:
                return ""
            chunk = m.group(1).strip()
            # Normalize React JSX SVG attributes to standard XML SVG attributes
            chunk = chunk.replace("<>", "").replace("</>", "")
            chunk = chunk.replace("fillRule=", "fill-rule=").replace("clipRule=", "clip-rule=")
            return chunk.rstrip(",").strip()

        specs = [
            ("ProviderCodex", "codex", True),
            ("ProviderClaude", "claude", False),
            ("ProviderPi", "pi", True),
            ("ProviderDsh", "dsh", True),
        ]
        for asset_name, key, is_template in specs:
            inner = extract_entry(key)
            if not inner:
                continue
            fill_attr = ' fill="#000000"' if is_template else ""
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"{fill_attr}>\n'
                f'  {inner}\n'
                '</svg>\n'
            )
            write_vector_imageset(assets_dir, asset_name, svg, template=is_template)

    # Exact Antigravity press SVG asset framed identically to Desktop RuntimeIcon.tsx (x=-3 y=-3 width=30 height=30 on 24x24 == viewBox 18 18 144 144 on 180x180)
    if ag_svg.exists():
        ag_dir = assets_dir / "ProviderAntigravity.imageset"
        ag_png = ag_dir / "ProviderAntigravity.png"
        ag_dir.mkdir(parents=True, exist_ok=True)
        needs_render = not ag_png.exists() or ag_svg.stat().st_mtime > ag_png.stat().st_mtime
        if needs_render:
            raw_svg = ag_svg.read_text(encoding="utf-8")
            # Render the SVG inline at full 360px Retina resolution (no intermediate 24px rasterization)
            framed_svg = raw_svg.replace('viewBox="0 0 180 180"', 'viewBox="18 18 144 144"', 1)
            render_svg_transparent_png(framed_svg, ag_png, size=180)
        (ag_dir / "Contents.json").write_text(
            '{\n'
            '  "images": [\n'
            '    {\n'
            '      "filename": "ProviderAntigravity.png",\n'
            '      "idiom": "universal"\n'
            '    }\n'
            '  ],\n'
            '  "info": {\n'
            '    "author": "xcode",\n'
            '    "version": 1\n'
            '  }\n'
            '}\n',
            encoding="utf-8",
        )


def generate() -> None:
    copy_icon()
    swift_files = sorted(p.relative_to(IOS_DIR).as_posix() for p in APP_DIR.rglob("*.swift"))

    # Stable deterministic object IDs
    ID_PROJECT = uid("project")
    ID_MAIN_GROUP = uid("group:main")
    ID_SOURCES_GROUP = uid("group:Lever")
    ID_FRAMEWORKS_GROUP = uid("group:Frameworks")
    ID_PRODUCTS_GROUP = uid("group:Products")
    ID_PRODUCT_APP = uid("product:Lever.app")
    ID_TARGET = uid("target:Lever")
    ID_SOURCES_PHASE = uid("phase:Sources")
    ID_FRAMEWORKS_PHASE = uid("phase:Frameworks")
    ID_RESOURCES_PHASE = uid("phase:Resources")
    ID_PROJ_CONFIG_LIST = uid("configlist:project")
    ID_TARGET_CONFIG_LIST = uid("configlist:target")
    ID_PROJ_DEBUG = uid("config:project:Debug")
    ID_PROJ_RELEASE = uid("config:project:Release")
    ID_TARGET_DEBUG = uid("config:target:Debug")
    ID_TARGET_RELEASE = uid("config:target:Release")

    ID_XCFRAMEWORK_REF = uid("fileref:LeverCore.xcframework")
    ID_XCFRAMEWORK_BUILD = uid("buildfile:LeverCore.xcframework")
    ID_ASSETS_REF = uid("fileref:Assets.xcassets")
    ID_ASSETS_BUILD = uid("buildfile:Assets.xcassets")
    ID_INFO_PLIST_REF = uid("fileref:Info.plist")
    ID_ENTITLEMENTS_REF = uid("fileref:Lever.entitlements")
    ID_LIBRESOLV_REF = uid("fileref:libresolv.tbd")
    ID_LIBRESOLV_BUILD = uid("buildfile:libresolv.tbd")
    ID_LIBSQLITE3_REF = uid("fileref:libsqlite3.tbd")
    ID_LIBSQLITE3_BUILD = uid("buildfile:libsqlite3.tbd")
    ID_TEXTUAL_PKG = uid("pkg:textual")
    ID_TEXTUAL_PROD = uid("pkgprod:Textual")
    ID_TEXTUAL_BUILD = uid("buildfile:Textual")

    build_files = [
        f"\t\t{ID_XCFRAMEWORK_BUILD} /* LeverCore.xcframework in Frameworks */ = {{isa = PBXBuildFile; fileRef = {ID_XCFRAMEWORK_REF} /* LeverCore.xcframework */; }};",
        f"\t\t{ID_LIBRESOLV_BUILD} /* libresolv.tbd in Frameworks */ = {{isa = PBXBuildFile; fileRef = {ID_LIBRESOLV_REF} /* libresolv.tbd */; }};",
        f"\t\t{ID_LIBSQLITE3_BUILD} /* libsqlite3.tbd in Frameworks */ = {{isa = PBXBuildFile; fileRef = {ID_LIBSQLITE3_REF} /* libsqlite3.tbd */; }};",
        f"\t\t{ID_TEXTUAL_BUILD} /* Textual in Frameworks */ = {{isa = PBXBuildFile; productRef = {ID_TEXTUAL_PROD} /* Textual */; }};",
        f"\t\t{ID_ASSETS_BUILD} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {ID_ASSETS_REF} /* Assets.xcassets */; }};",
    ]
    file_refs = [
        f"\t\t{ID_PRODUCT_APP} /* Lever.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Lever.app; sourceTree = BUILT_PRODUCTS_DIR; }};",
        f"\t\t{ID_XCFRAMEWORK_REF} /* LeverCore.xcframework */ = {{isa = PBXFileReference; lastKnownFileType = wrapper.xcframework; name = LeverCore.xcframework; path = Frameworks/LeverCore.xcframework; sourceTree = \"<group>\"; }};",
        f"\t\t{ID_LIBRESOLV_REF} /* libresolv.tbd */ = {{isa = PBXFileReference; lastKnownFileType = \"sourcecode.text-based-dylib-definition\"; name = libresolv.tbd; path = usr/lib/libresolv.tbd; sourceTree = SDKROOT; }};",
        f"\t\t{ID_LIBSQLITE3_REF} /* libsqlite3.tbd */ = {{isa = PBXFileReference; lastKnownFileType = \"sourcecode.text-based-dylib-definition\"; name = libsqlite3.tbd; path = usr/lib/libsqlite3.tbd; sourceTree = SDKROOT; }};",
        f"\t\t{ID_ASSETS_REF} /* Assets.xcassets */ = {{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Lever/Resources/Assets.xcassets; sourceTree = \"<group>\"; }};",
        f"\t\t{ID_INFO_PLIST_REF} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Lever/Resources/Info.plist; sourceTree = \"<group>\"; }};",
        f"\t\t{ID_ENTITLEMENTS_REF} /* Lever.entitlements */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = Lever/Resources/Lever.entitlements; sourceTree = \"<group>\"; }};",
    ]
    source_build_entries = []
    source_group_children = [
        f"\t\t\t\t{ID_ASSETS_REF} /* Assets.xcassets */,",
        f"\t\t\t\t{ID_INFO_PLIST_REF} /* Info.plist */,",
        f"\t\t\t\t{ID_ENTITLEMENTS_REF} /* Lever.entitlements */,",
    ]

    for rel in swift_files:
        name = Path(rel).name
        f_id = uid(f"fileref:{rel}")
        b_id = uid(f"buildfile:{rel}")
        file_refs.append(
            f"\t\t{f_id} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = {name}; path = {rel}; sourceTree = \"<group>\"; }};"
        )
        build_files.append(
            f"\t\t{b_id} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = {f_id} /* {name} */; }};"
        )
        source_build_entries.append(f"\t\t\t\t{b_id} /* {name} in Sources */,")
        source_group_children.append(f"\t\t\t\t{f_id} /* {name} */,")

    common_target_settings = """
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CODE_SIGN_ENTITLEMENTS = Lever/Resources/Lever.entitlements;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				DEVELOPMENT_TEAM = "";
				ENABLE_PREVIEWS = YES;
				"EXCLUDED_ARCHS[sdk=iphonesimulator*]" = x86_64;
				FRAMEWORK_SEARCH_PATHS = (
					"$(inherited)",
					"$(PROJECT_DIR)/Frameworks",
				);
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = Lever/Resources/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 18.0;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 0.1.0;
				OTHER_LDFLAGS = (
					"$(inherited)",
					"-framework",
					"Security",
					"-framework",
					"Network",
					"-framework",
					"UserNotifications",
					"-framework",
					"AVFoundation",
					"-framework",
					"CFNetwork",
					"-framework",
					"SystemConfiguration",
				);
				PRODUCT_BUNDLE_IDENTIFIER = app.lever.mobile;
				PRODUCT_NAME = Lever;
				SDKROOT = iphoneos;
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				SUPPORTS_MACCATALYST = NO;
				SWIFT_EMIT_LOC_STRINGS = NO;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
"""

    pbxproj = f"""// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 56;
	objects = {{

/* Begin PBXBuildFile section */
{chr(10).join(build_files)}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
{chr(10).join(file_refs)}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		{ID_FRAMEWORKS_PHASE} /* Frameworks */ = {{
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
				{ID_XCFRAMEWORK_BUILD} /* LeverCore.xcframework in Frameworks */,
				{ID_LIBRESOLV_BUILD} /* libresolv.tbd in Frameworks */,
				{ID_LIBSQLITE3_BUILD} /* libsqlite3.tbd in Frameworks */,
				{ID_TEXTUAL_BUILD} /* Textual in Frameworks */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		{ID_MAIN_GROUP} = {{
			isa = PBXGroup;
			children = (
				{ID_SOURCES_GROUP} /* Lever */,
				{ID_FRAMEWORKS_GROUP} /* Frameworks */,
				{ID_PRODUCTS_GROUP} /* Products */,
			);
			sourceTree = "<group>";
		}};
		{ID_SOURCES_GROUP} /* Lever */ = {{
			isa = PBXGroup;
			children = (
{chr(10).join(source_group_children)}
			);
			name = Lever;
			sourceTree = "<group>";
		}};
		{ID_FRAMEWORKS_GROUP} /* Frameworks */ = {{
			isa = PBXGroup;
			children = (
				{ID_XCFRAMEWORK_REF} /* LeverCore.xcframework */,
				{ID_LIBRESOLV_REF} /* libresolv.tbd */,
				{ID_LIBSQLITE3_REF} /* libsqlite3.tbd */,
			);
			name = Frameworks;
			sourceTree = "<group>";
		}};
		{ID_PRODUCTS_GROUP} /* Products */ = {{
			isa = PBXGroup;
			children = (
				{ID_PRODUCT_APP} /* Lever.app */,
			);
			name = Products;
			sourceTree = "<group>";
		}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		{ID_TARGET} /* Lever */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {ID_TARGET_CONFIG_LIST} /* Build configuration list for PBXNativeTarget "Lever" */;
			buildPhases = (
				{ID_SOURCES_PHASE} /* Sources */,
				{ID_FRAMEWORKS_PHASE} /* Frameworks */,
				{ID_RESOURCES_PHASE} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = Lever;
			packageProductDependencies = (
				{ID_TEXTUAL_PROD} /* Textual */,
			);
			productName = Lever;
			productReference = {ID_PRODUCT_APP} /* Lever.app */;
			productType = "com.apple.product-type.application";
		}};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		{ID_PROJECT} /* Project object */ = {{
			isa = PBXProject;
			attributes = {{
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
			}};
			buildConfigurationList = {ID_PROJ_CONFIG_LIST} /* Build configuration list for PBXProject "Lever" */;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = zh_CN;
			hasScannedForEncodings = 0;
			knownRegions = (
				zh_CN,
				en,
				Base,
			);
			mainGroup = {ID_MAIN_GROUP};
			packageReferences = (
				{ID_TEXTUAL_PKG} /* XCRemoteSwiftPackageReference "textual" */,
			);
			productRefGroup = {ID_PRODUCTS_GROUP} /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				{ID_TARGET} /* Lever */,
			);
		}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		{ID_RESOURCES_PHASE} /* Resources */ = {{
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				{ID_ASSETS_BUILD} /* Assets.xcassets in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		{ID_SOURCES_PHASE} /* Sources */ = {{
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
{chr(10).join(source_build_entries)}
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		{ID_PROJ_DEBUG} /* Debug */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				DEBUG_INFORMATION_FORMAT = dwarf;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				ENABLE_TESTABILITY = YES;
				GCC_OPTIMIZATION_LEVEL = 0;
				IPHONEOS_DEPLOYMENT_TARGET = 18.0;
				MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;
				ONLY_ACTIVE_ARCH = YES;
				SDKROOT = iphoneos;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
			}};
			name = Debug;
		}};
		{ID_PROJ_RELEASE} /* Release */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
				ENABLE_NS_ASSERTIONS = NO;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 18.0;
				SDKROOT = iphoneos;
				SWIFT_COMPILATION_MODE = wholemodule;
				SWIFT_OPTIMIZATION_LEVEL = "-O";
				VALIDATE_PRODUCT = YES;
			}};
			name = Release;
		}};
		{ID_TARGET_DEBUG} /* Debug */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{{common_target_settings}			}};
			name = Debug;
		}};
		{ID_TARGET_RELEASE} /* Release */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{{common_target_settings}			}};
			name = Release;
		}};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		{ID_PROJ_CONFIG_LIST} /* Build configuration list for PBXProject "Lever" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{ID_PROJ_DEBUG} /* Debug */,
				{ID_PROJ_RELEASE} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
		{ID_TARGET_CONFIG_LIST} /* Build configuration list for PBXNativeTarget "Lever" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{ID_TARGET_DEBUG} /* Debug */,
				{ID_TARGET_RELEASE} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
/* End XCConfigurationList section */

/* Begin XCRemoteSwiftPackageReference section */
		{ID_TEXTUAL_PKG} /* XCRemoteSwiftPackageReference "textual" */ = {{
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/gonzalezreal/textual";
			requirement = {{
				kind = upToNextMinorVersion;
				minimumVersion = 0.5.0;
			}};
		}};
/* End XCRemoteSwiftPackageReference section */

/* Begin XCSwiftPackageProductDependency section */
		{ID_TEXTUAL_PROD} /* Textual */ = {{
			isa = XCSwiftPackageProductDependency;
			package = {ID_TEXTUAL_PKG} /* XCRemoteSwiftPackageReference "textual" */;
			productName = Textual;
		}};
/* End XCSwiftPackageProductDependency section */
	}};
	rootObject = {ID_PROJECT} /* Project object */;
}}
"""

    PROJ_DIR.mkdir(parents=True, exist_ok=True)
    (PROJ_DIR / "project.pbxproj").write_text(pbxproj, encoding="utf-8")

    SCHEMES_DIR.mkdir(parents=True, exist_ok=True)
    scheme = f"""<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{ID_TARGET}"
               BuildableName = "Lever.app"
               BlueprintName = "Lever"
               ReferencedContainer = "container:Lever.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "{ID_TARGET}"
            BuildableName = "Lever.app"
            BlueprintName = "Lever"
            ReferencedContainer = "container:Lever.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
"""
    (SCHEMES_DIR / "Lever.xcscheme").write_text(scheme, encoding="utf-8")
    print(f"Generated {PROJ_DIR} ({len(swift_files)} Swift files)")


if __name__ == "__main__":
    generate()
