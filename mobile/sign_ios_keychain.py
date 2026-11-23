"""Scope MyGo's development signature to Lever's private keychain group."""

import hashlib
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path


def sign(ipa):
    with tempfile.TemporaryDirectory(dir=ipa.parent) as work:
        work = Path(work)
        archive = work / "archive"
        subprocess.run(["ditto", "-x", "-k", ipa, archive], check=True)
        (app,) = (archive / "Payload").glob("*.app")
        entitlements = plistlib.loads(
            subprocess.check_output(["codesign", "-d", "--entitlements", "-", "--xml", app])
        )
        # MyGo copies the profile's list of allowed groups into the signature.
        # Lever stores its pairing credential in its own application group.
        app_id = entitlements["application-identifier"]
        if entitlements.get("keychain-access-groups") in (None, [app_id]):
            return
        entitlements["keychain-access-groups"] = [app_id]
        plist = work / "entitlements.plist"
        plist.write_bytes(plistlib.dumps(entitlements))

        subprocess.run(["codesign", "-d", f"--extract-certificates={work}/cert", app], check=True)
        identity = hashlib.sha1((work / "cert0").read_bytes()).hexdigest()
        subprocess.run(
            ["codesign", "--force", "--sign", identity, "--entitlements", plist,
             "--generate-entitlement-der", app],
            check=True,
        )
        subprocess.run(["codesign", "--verify", "--deep", "--strict", app], check=True)
        result = work / "signed.ipa"
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", archive, result], check=True)
        os.replace(result, ipa)


if __name__ == "__main__":
    (path,) = sys.argv[1:]
    sign(Path(path).resolve())
