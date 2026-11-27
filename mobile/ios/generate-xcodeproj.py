#!/usr/bin/env python3
"""Generate mobile/ios/Lever.xcodeproj cleanly from mobile/ios/Lever sources."""

import hashlib
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
    ID_TEXTUAL_PKG = uid("pkg:textual")
    ID_TEXTUAL_PROD = uid("pkgprod:Textual")
    ID_TEXTUAL_BUILD = uid("buildfile:Textual")

    build_files = [
        f"\t\t{ID_XCFRAMEWORK_BUILD} /* LeverCore.xcframework in Frameworks */ = {{isa = PBXBuildFile; fileRef = {ID_XCFRAMEWORK_REF} /* LeverCore.xcframework */; }};",
        f"\t\t{ID_LIBRESOLV_BUILD} /* libresolv.tbd in Frameworks */ = {{isa = PBXBuildFile; fileRef = {ID_LIBRESOLV_REF} /* libresolv.tbd */; }};",
        f"\t\t{ID_TEXTUAL_BUILD} /* Textual in Frameworks */ = {{isa = PBXBuildFile; productRef = {ID_TEXTUAL_PROD} /* Textual */; }};",
        f"\t\t{ID_ASSETS_BUILD} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {ID_ASSETS_REF} /* Assets.xcassets */; }};",
    ]
    file_refs = [
        f"\t\t{ID_PRODUCT_APP} /* Lever.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Lever.app; sourceTree = BUILT_PRODUCTS_DIR; }};",
        f"\t\t{ID_XCFRAMEWORK_REF} /* LeverCore.xcframework */ = {{isa = PBXFileReference; lastKnownFileType = wrapper.xcframework; name = LeverCore.xcframework; path = Frameworks/LeverCore.xcframework; sourceTree = \"<group>\"; }};",
        f"\t\t{ID_LIBRESOLV_REF} /* libresolv.tbd */ = {{isa = PBXFileReference; lastKnownFileType = \"sourcecode.text-based-dylib-definition\"; name = libresolv.tbd; path = usr/lib/libresolv.tbd; sourceTree = SDKROOT; }};",
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
