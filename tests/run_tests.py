#!/usr/bin/env python3
"""
Automated Unit & Integration Test Suite for wphoto-extension.
Usage: python3 run_tests.py /path/to/wphoto-extension
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time

JSC_BIN = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"


def run_jsc(script_code):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
        tf.write(script_code)
        tmp_path = tf.name
    try:
        res = subprocess.run(
            [JSC_BIN, tmp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )
        if res.returncode != 0:
            raise AssertionError(f"JSC execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}")
        return res.stdout.strip()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def check_js_syntax(file_path):
    code = f"checkSyntax({json.dumps(file_path)}); print('SYNTAX_OK');"
    out = run_jsc(code)
    assert "SYNTAX_OK" in out, f"Syntax check failed for {file_path}"


class TestRunner:
    def __init__(self, ext_dir):
        self.ext_dir = os.path.abspath(ext_dir)
        self.passed = 0
        self.failed = 0

    def run_test(self, code_id, name, fn):
        try:
            fn()
            print(f"  [PASS] {code_id}: {name}")
            self.passed += 1
        except Exception as exc:
            print(f"  [FAIL] {code_id}: {name}\n         Reason: {exc}")
            self.failed += 1


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 run_tests.py <path_to_wphoto_extension>")
        sys.exit(2)

    ext_dir = os.path.abspath(sys.argv[1])
    print("=" * 72)
    print("  WPHOTO-EXTENSION - AUTOMATED TEST SUITE")
    print(f"  Target Directory: {ext_dir}")
    print("=" * 72)

    runner = TestRunner(ext_dir)
    t_start = time.time()

    # -------------------------------------------------------------------------
    # Suite 1: Packaging, Manifest & Icon-Free Cleanliness
    # -------------------------------------------------------------------------
    print("\n--- Suite 1: Packaging, Manifest & Icon-Free Cleanliness ---")

    def pkg_01():
        manifest_path = os.path.join(ext_dir, "manifest.json")
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        assert manifest.get("manifest_version") == 3
        assert manifest.get("name") == "AI Plus", f"Expected manifest name 'AI Plus', got {manifest.get('name')}"
        assert "icons" not in manifest, "manifest.json must not declare icons"
        assert "action" not in manifest or "default_icon" not in manifest.get("action", {})
        assert manifest["background"]["service_worker"] == "background/background.js"
        cs = manifest["content_scripts"][0]
        assert cs["js"][0] == "prompts.js", "prompts.js must be loaded first"
        assert set(manifest["permissions"]) == {"storage", "debugger", "scripting"}

    def pkg_02():
        manifest_path = os.path.join(ext_dir, "manifest.json")
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        files_to_check = [manifest["background"]["service_worker"]]
        for cs in manifest["content_scripts"]:
            files_to_check.extend(cs.get("js", []))
            files_to_check.extend(cs.get("css", []))
        for rel in files_to_check:
            full = os.path.join(ext_dir, rel)
            assert os.path.isfile(full), f"Missing declared file: {rel}"
            assert os.path.getsize(full) > 0, f"Empty file: {rel}"

        total_bytes = 0
        for root, dirs, files in os.walk(ext_dir):
            dirs[:] = [d for d in dirs if d not in ("tests", "__pycache__", ".git", "dist")]
            for fn in files:
                assert not fn.endswith((".png", ".svg", ".ico", ".onnx", ".wasm")), (
                    f"Unexpected binary/icon asset found: {fn}"
                )
                total_bytes += os.path.getsize(os.path.join(root, fn))
        assert total_bytes < 250 * 1024, f"Extension size too large: {total_bytes} bytes"

    def pkg_03():
        for root, dirs, files in os.walk(ext_dir):
            dirs[:] = [d for d in dirs if d not in ("tests", "__pycache__", ".git", "dist")]
            for fn in files:
                assert not fn.endswith(".pem"), f"Private key file found: {fn}"
                if fn.endswith((".js", ".json", ".css")):
                    full = os.path.join(root, fn)
                    with open(full, "r", encoding="utf-8") as f:
                        content = f.read()
                    assert not re.search(r"AIzaSy[A-Za-z0-9_-]{30,}", content), (
                        f"Hardcoded Gemini API key found in {fn}"
                    )

    def pkg_04():
        for root, dirs, files in os.walk(ext_dir):
            dirs[:] = [d for d in dirs if d not in (".git", "dist", "__pycache__")]
            for fn in files:
                if fn.endswith(".js"):
                    check_js_syntax(os.path.join(root, fn))

    def pkg_05():
        prompts_path = os.path.join(ext_dir, "prompts.js")
        with open(prompts_path, "r", encoding="utf-8") as f:
            src = f.read()
        assert "function" not in src, "prompts.js must contain ONLY prompt templates, no functions"
        assert "=>{" not in src and "=> " not in src, "prompts.js must not contain arrow functions"
        assert "document." not in src and "chrome." not in src, "prompts.js must not contain DOM/Chrome calls"

    runner.run_test("PKG-01", "Valid MV3 manifest with zero icons and clean permissions", pkg_01)
    runner.run_test("PKG-02", "All declared files exist, zero icon/WASM bloat, lightweight payload", pkg_02)
    runner.run_test("PKG-03", "Zero hardcoded API keys or .pem files in package", pkg_03)
    runner.run_test("PKG-04", "All JavaScript files pass JSC checkSyntax verification", pkg_04)
    runner.run_test("PKG-05", "prompts.js contains ONLY declarative prompt templates per language", pkg_05)

    # -------------------------------------------------------------------------
    # Suite 2: Multi-Language Prompt Templates & Single-File Extensibility
    # -------------------------------------------------------------------------
    print("\n--- Suite 2: Multi-Language Prompt Templates & Single-File Extensibility ---")

    prompts_file = json.dumps(os.path.join(ext_dir, "prompts.js"))
    dom_file = json.dumps(os.path.join(ext_dir, "content/dom-caption.js"))
    ai_file = json.dumps(os.path.join(ext_dir, "content/ai-engine.js"))
    sel_file = json.dumps(os.path.join(ext_dir, "content/selection.js"))
    runner_file = json.dumps(os.path.join(ext_dir, "content/batch-runner.js"))
    ui_file = json.dumps(os.path.join(ext_dir, "content/ui.js"))

    def prm_01():
        js = f"""
        globalThis.window = globalThis;
        globalThis.chrome = {{ storage: {{ local: {{ get: async () => ({{}}), set: async () => {{}} }} }} }};
        globalThis.performance = {{ now: () => 0 }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        const prompts = window.WPHOTO_PROMPTS;
        const requiredKeys = [
          "label", "andWord", "inWord", "untaggedOne", "untaggedMany",
          "system", "peopleTagged", "peopleNone", "strictRules",
          "locationRule", "instructionWithPeople", "instructionNoPeople"
        ];
        for (const lang of ["en", "fr", "es"]) {{
          if (!prompts[lang]) throw new Error("Missing language: " + lang);
          for (const k of requiredKeys) {{
            if (typeof prompts[lang][k] !== "string" || !prompts[lang][k].trim()) {{
              throw new Error("Missing key " + k + " in " + lang);
            }}
          }}
        }}
        print("PRM_01_OK");
        """
        assert "PRM_01_OK" in run_jsc(js)

    def prm_02():
        js = f"""
        globalThis.window = globalThis;
        globalThis.chrome = {{ storage: {{ local: {{ get: async () => ({{}}), set: async () => {{}} }} }} }};
        globalThis.performance = {{ now: () => 0 }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        const ai = window.WPhotoAiEngine;

        // 1. 0 tagged people
        const r0 = ai.buildRules({{ people: [], untaggedCount: 0, location: null }}, "en");
        if (!r0.includes("No people are tagged in this photo.")) throw new Error("r0 failed: " + r0);

        // 2. 1+ tagged people, 0 untagged
        const r1 = ai.buildRules({{ people: ["Alice Smith", "Bob Jones"], untaggedCount: 0, location: null }}, "en");
        if (!r1.includes("Tagged people in this photo: Alice, Bob.")) throw new Error("r1 failed: " + r1);

        // 3. 1+ tagged people, 1 untagged (FR)
        const r2 = ai.buildRules({{ people: ["Alice Smith"], untaggedCount: 1, location: null }}, "fr");
        if (!r2.includes("Personnes identifiées sur cette photo: Alice, plus une autre personne non identifiée.")) {{
          throw new Error("r2 failed: " + r2);
        }}

        // 4. 1+ tagged people, 2+ untagged (ES) + concise location
        const r3 = ai.buildRules({{ people: ["Alice Smith", "Bob"], untaggedCount: 3, location: "Madrid, Spain" }}, "es");
        if (!r3.includes("Personas identificadas en esta foto: Alice, Bob, más 3 otras personas no identificadas.")) {{
          throw new Error("r3 failed: " + r3);
        }}
        if (!r3.includes("El lugar identificado es 'Madrid, Spain'.") || !r3.includes("mantenlo conciso y natural")) {{
          throw new Error("r3 location failed: " + r3);
        }}

        // Concise location in EN and FR
        const rEnLoc = ai.buildRules({{ people: [], untaggedCount: 0, location: "Venice, Metropolitan City of Venice, Italy" }}, "en");
        if (!rEnLoc.includes("keep it concise and natural")) throw new Error("EN short location missing");

        const rFrLoc = ai.buildRules({{ people: [], untaggedCount: 0, location: "Venice, Metropolitan City of Venice, Italy" }}, "fr");
        if (!rFrLoc.includes("gardez-le concis et naturel")) throw new Error("FR short location missing");

        print("PRM_02_OK");
        """
        assert "PRM_02_OK" in run_jsc(js)

    def prm_03():
        js = f"""
        globalThis.window = globalThis;
        globalThis.chrome = {{ storage: {{ local: {{ get: async () => ({{}}), set: async () => {{}} }} }} }};
        globalThis.performance = {{ now: () => 0 }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        const prompts = window.WPHOTO_PROMPTS;
        const ai = window.WPhotoAiEngine;

        const iNoPeople = ai.buildInstruction({{ people: [] }}, "en");
        if (!iNoPeople.includes("Golden Gate Bridge")) throw new Error("iNoPeople failed");

        const i1 = ai.buildInstruction({{ people: ["Alice"] }}, "en");
        if (!i1.includes("START directly with their names: 'Alice'")) throw new Error("i1 failed");

        const i2Fr = ai.buildInstruction({{ people: ["Alice", "Bob"] }}, "fr");
        if (!i2Fr.includes("'Alice et Bob'")) throw new Error("i2Fr failed: " + i2Fr);

        const i3Es = ai.buildInstruction({{ people: ["Alice", "Bob", "Carlos"] }}, "es");
        if (!i3Es.includes("'Alice, Bob y Carlos'")) throw new Error("i3Es failed: " + i3Es);

        // Single-file extensibility: add Italian dynamically to WPHOTO_PROMPTS
        prompts.it = {{
          label: "Italiano",
          andWord: "e",
          inWord: "a",
          untaggedOne: "un'altra persona",
          untaggedMany: "{{count}} altre persone",
          system: "Rispondi in italiano.",
          peopleTagged: "Persone: {{people}}.",
          peopleNone: "Nessuna persona.",
          strictRules: "Regole.",
          locationRule: "Luogo: '{{location}}'.",
          instructionWithPeople: "Inizia con '{{names}}'.",
          instructionNoPeople: "Descrivi la scena."
        }};
        const itInstr = ai.buildInstruction({{ people: ["Marco", "Giulia"] }}, "it");
        if (itInstr !== "Inizia con 'Marco e Giulia'.") throw new Error("Italian dynamic instruction failed: " + itInstr);
        const itMeta = ai.composeMetadataCaption({{ people: ["Marco", "Giulia"], location: "Roma", year: "2024" }}, "it");
        if (itMeta !== "Marco e Giulia a Roma, 2024.") throw new Error("Italian metadata fallback failed: " + itMeta);

        // Preamble cleaner across EN, FR, ES (keeps up to 2 sentences, drops 3rd+)
        if (ai.cleanGeneratedCaption("Here's a caption:\\nA photo of the Eiffel Tower at dusk. Second sentence. Third sentence.") !== "The Eiffel Tower at dusk. Second sentence.") {{
          throw new Error("EN clean failed");
        }}
        if (ai.cleanGeneratedCaption("Voici une proposition de légende : Une photo montrant le Mont-Saint-Michel sous la brume.") !== "Le Mont-Saint-Michel sous la brume.") {{
          throw new Error("FR clean failed");
        }}
        if (ai.cleanGeneratedCaption("Aquí tienes: Una foto de la Alhambra de Granada al atardecer.") !== "La Alhambra de Granada al atardecer.") {{
          throw new Error("ES clean failed");
        }}

        print("PRM_03_OK");
        """
        assert "PRM_03_OK" in run_jsc(js)

    runner.run_test("PRM-01", "English, French, and Spanish templates defined with all required keys", prm_01)
    runner.run_test("PRM-02", "All 4 people/untagged combinations and concise location rules (EN/FR/ES)", prm_02)
    runner.run_test("PRM-03", "Instruction branches, 1-file language extensibility (IT), and preamble cleaners", prm_03)

    # -------------------------------------------------------------------------
    # Suite 3: Two Selection Techniques (selection.js)
    # -------------------------------------------------------------------------
    print("\n--- Suite 3: Two Selection Techniques (selection.js) ---")

    def sel_01():
        js = f"""
        globalThis.window = globalThis;
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        let mockCheckboxes = [];
        let mockAlbumLinks = [];
        let mockScripts = [];
        globalThis.location = {{ pathname: "/u/1/album/ALBUM_123", href: "https://photos.google.com/u/1/album/ALBUM_123" }};
        globalThis.getComputedStyle = () => ({{ overflowY: "visible" }});
        globalThis.document = {{
          documentElement: null,
          body: {{}},
          querySelectorAll(sel) {{
            if (sel.includes('[role="checkbox"][aria-checked="true"]')) return mockCheckboxes;
            if (sel === 'a[href*="/photo/"]') return mockAlbumLinks;
            if (sel === "script") return mockScripts;
            return [];
          }},
          querySelector(sel) {{
            if (sel === "video") return null;
            if (sel.includes("Clear selection")) return mockCheckboxes.length > 0 ? {{ offsetParent: {{}} }} : null;
            if (sel === 'a[href*="/photo/"]') return mockAlbumLinks[0] || null;
            return null;
          }}
        }};

        load({sel_file});
        const sel = window.WPhotoSelection;

        // 1. Account prefix & URL builder
        if (sel.buildPhotoUrl("/u/2/album/xyz", "PHOTO_99") !== "https://photos.google.com/u/2/photo/PHOTO_99") {{
          throw new Error("buildPhotoUrl failed");
        }}

        // 2. Technique 2: Album mode when 0 checkboxes selected
        const sumAlbum = sel.getSummary();
        if (sumAlbum.mode !== "album" || !sumAlbum.inAlbum || sumAlbum.eligible !== 0) {{
          throw new Error("Album summary failed: " + JSON.stringify(sumAlbum));
        }}

        // 3. Technique 1: Grid selection (eligible photo, photo stack, and skipped video)
        function makeTile(id, label, hasDuration = false) {{
          const link = {{
            getAttribute: (k) => (k === "href" ? "/photo/" + id : k === "aria-label" ? label : null),
            parentElement: {{
              querySelectorAll: () => (hasDuration ? [{{ children: [], textContent: "0:14" }}] : [])
            }}
          }};
          return {{
            getAttribute: (k) => (k === "role" ? "checkbox" : k === "aria-checked" ? "true" : k === "aria-label" ? label : null),
            querySelector: (s) => (s === 'a[href*="/photo/"]' ? link : null),
            parentElement: null
          }};
        }}

        mockCheckboxes = [
          makeTile("P_ELIGIBLE_1", "Photo - Oct 12, 2025"),
          makeTile("P_STACK_2", "Photo - Top shot - Oct 12, 2025"),
          makeTile("V_SKIP_3", "Video - Oct 12, 2025", true),
          makeTile("P_SHARED_4", "Photo - Oct 12, 2025 - Shared by Alice")
        ];

        const elig = sel.getEligibleIds();
        const skip = sel.getSkippedIds();
        if (JSON.stringify(elig) !== JSON.stringify(["P_ELIGIBLE_1", "P_STACK_2"])) {{
          throw new Error("Eligible IDs mismatch: " + JSON.stringify(elig));
        }}
        if (JSON.stringify(skip) !== JSON.stringify(["V_SKIP_3", "P_SHARED_4"])) {{
          throw new Error("Skipped IDs mismatch: " + JSON.stringify(skip));
        }}

        // 4. Technique 2 execution: enumerateCurrentAlbum
        mockAlbumLinks = [
          {{ offsetParent: {{}}, getAttribute: (k) => (k === "href" ? "/photo/ALB_P1" : "Photo - Jan 1"), querySelector: () => null, parentElement: {{ querySelectorAll: () => [] }} }},
          {{ offsetParent: {{}}, getAttribute: (k) => (k === "href" ? "/photo/ALB_P2" : "Photo - Jan 2"), querySelector: () => null, parentElement: {{ querySelectorAll: () => [] }} }},
          {{ offsetParent: {{}}, getAttribute: (k) => (k === "href" ? "/photo/ALB_V1" : "Video - Jan 3"), querySelector: () => null, parentElement: {{ querySelectorAll: () => [] }} }}
        ];

        (async () => {{
          const domRes = await sel.enumerateCurrentAlbum();
          if (JSON.stringify(domRes.ids) !== JSON.stringify(["ALB_P1", "ALB_P2"])) {{
            throw new Error("Album DOM enumeration failed: " + JSON.stringify(domRes));
          }}
          if (JSON.stringify(domRes.skippedIds) !== JSON.stringify(["ALB_V1"])) {{
            throw new Error("Album DOM skippedIds failed: " + JSON.stringify(domRes));
          }}

          // 5. Upfront RPC (snAcKc) unowned filtering when ds:7 script is absent (SPA navigation to /album/<id>)
          sel.clearAll();
          mockScripts = [
            {{
              textContent: '"SNlM0e":"AT_1","FdrFJe":"SID_1","cfb2h":"BL_1","eptZe":"/_/PhotosUi/","S06Grb":"11111222223333344444"'
            }}
          ];
          mockAlbumLinks = [
            {{ offsetParent: {{}}, getAttribute: (k) => (k === "href" ? "/photo/RPC_DOM_UNOWNED" : "Photo - Jan 4 - Partagé par Marc"), querySelector: () => null, parentElement: {{ querySelectorAll: () => [] }} }}
          ];
          globalThis.fetch = async () => ({{
            ok: true,
            status: 200,
            text: async () => {{
              const inner = JSON.stringify([
                null,
                [
                  // Viewer-owned photo: has ["AF1QipViewerActor0000000001"],[[1],...]
                  ["RPC_OWNED_1", ["https://lh3.googleusercontent.com/p1", 1600, 1200], 1700000000000, "d1", 0, ["AF1QipViewerActor0000000001"], [[1], "lib1"], {{}}],
                  // Unowned photo #1: contributor block has null instead of [[1],...]
                  ["RPC_UNOWNED_1", ["https://lh3.googleusercontent.com/p2", 1600, 1200], 1700000001000, "d2", 0, ["AF1QipOtherActor00000000002"], null, {{}}],
                  // Unowned photo #2: contributor actor ID differs from viewer's S06Grb actor ID
                  ["RPC_UNOWNED_2", ["https://lh3.googleusercontent.com/p3", 1600, 1200], 1700000002000, "d3", 0, ["AF1QipOtherActor00000000002"], [[1], "other"], {{}}],
                  // Unowned photo #3: caught by rendered DOM tile cross-check ("Partagé par Marc")
                  ["RPC_DOM_UNOWNED", ["https://lh3.googleusercontent.com/p4", 1600, 1200], 1700000003000, "d4", 0, {{}}]
                ],
                null,
                [
                  "ALBUM_123",
                  "Shared Trip",
                  [
                    ["AF1QipViewerActor0000000001", "11111222223333344444"],
                    ["AF1QipOtherActor00000000002", "99999888887777766666"]
                  ]
                ]
              ]);
              return ")}}]'\\n\\n" + JSON.stringify([["wrb.fr", "snAcKc", inner]]);
            }}
          }});

          const rpcRes = await sel.enumerateCurrentAlbum();
          if (JSON.stringify(rpcRes.ids) !== JSON.stringify(["RPC_OWNED_1"])) {{
            throw new Error("Expected snAcKc RPC enumeration to keep only RPC_OWNED_1, got: " + JSON.stringify(rpcRes));
          }}
          if (JSON.stringify(rpcRes.skippedIds) !== JSON.stringify(["RPC_UNOWNED_1", "RPC_UNOWNED_2", "RPC_DOM_UNOWNED"])) {{
            throw new Error("Expected snAcKc RPC enumeration to skip all 3 unowned photos upfront, got: " + JSON.stringify(rpcRes));
          }}

          // 6. Single photo viewer (/photo/<id>) disables selection (eligible === 0)
          globalThis.location.pathname = "/photo/SINGLE_PHOTO_1";
          const viewerSum = sel.getSummary();
          if (viewerSum.mode !== "viewer" || viewerSum.eligible !== 0 || sel.getEligibleIds().length !== 0) {{
            throw new Error("Expected single photo viewer to have 0 eligible items: " + JSON.stringify(viewerSum));
          }}
          print("SEL_01_OK");
        }})();
        """
        assert "SEL_01_OK" in run_jsc(js)

    runner.run_test(
        "SEL-01",
        "Technique 1 (Grid checkboxes + stacks), Technique 2 (Album enumeration), and single-photo disable",
        sel_01,
    )

    def sel_02():
        js = f"""
        globalThis.window = globalThis;
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        let observerCb = null;
        let checkboxQueryCount = 0;
        let mockScripts = [];
        let mockAlbumLinks = [];
        let mockAccountBtns = [];
        let mockChecked = [];
        globalThis.location = {{ pathname: "/album/ALB_2", href: "https://photos.google.com/album/ALB_2" }};
        globalThis.getComputedStyle = () => ({{ overflowY: "visible" }});
        globalThis.MutationObserver = class {{
          constructor(cb) {{ observerCb = cb; }}
          observe() {{}}
        }};
        globalThis.document = {{
          documentElement: {{}},
          body: {{}},
          querySelectorAll(sel) {{
            if (sel.includes('[role="checkbox"][aria-checked="true"]')) {{ checkboxQueryCount++; return mockChecked; }}
            if (sel === 'a[href*="/photo/"]') return mockAlbumLinks;
            if (sel === "script") return mockScripts;
            if (sel.includes('a[role="button"][aria-label]')) return mockAccountBtns;
            return [];
          }},
          querySelector(sel) {{
            if (sel === 'a[href*="/photo/"]') return mockAlbumLinks[0] || null;
            if (sel.includes("Clear selection")) return mockChecked.length > 0 ? {{ offsetParent: {{}} }} : null;
            return null;
          }}
        }};

        load({sel_file});
        const sel = window.WPhotoSelection;

        (async () => {{
          // 1. RPC HTTP 500 and AbortError both fall back cleanly to DOM enumeration
          mockScripts = [{{ textContent: '"SNlM0e":"AT","FdrFJe":"SID","cfb2h":"BL","eptZe":"/_/"' }}];
          mockAlbumLinks = [
            {{ offsetParent: {{}}, getAttribute: (k) => (k === "href" ? "/photo/DOM_P1" : "Photo - Jan 1"), querySelector: () => null, parentElement: {{ querySelectorAll: () => [] }} }},
            {{ offsetParent: {{}}, getAttribute: (k) => (k === "href" ? "/photo/DOM_V1" : "Video - Jan 2"), querySelector: () => null, parentElement: {{ querySelectorAll: () => [] }} }}
          ];
          globalThis.fetch = async () => ({{ ok: false, status: 500 }});
          const fallback500 = await sel.enumerateCurrentAlbum();
          if (JSON.stringify(fallback500.ids) !== JSON.stringify(["DOM_P1"]) || JSON.stringify(fallback500.skippedIds) !== JSON.stringify(["DOM_V1"])) {{
            throw new Error("Expected HTTP 500 RPC to fall back to DOM: " + JSON.stringify(fallback500));
          }}
          globalThis.fetch = async () => {{ const e = new Error("aborted"); e.name = "AbortError"; throw e; }};
          const fallbackAbort = await sel.enumerateCurrentAlbum();
          if (JSON.stringify(fallbackAbort.ids) !== JSON.stringify(["DOM_P1"])) {{
            throw new Error("Expected AbortError RPC to fall back to DOM: " + JSON.stringify(fallbackAbort));
          }}

          // 2. Multi-page snAcKc RPC deduplicates overlapping mediaKey
          mockAlbumLinks = [];
          let page = 0;
          globalThis.fetch = async () => {{
            page++;
            const inner = JSON.stringify([
              null,
              [["P_DUP", ["https://lh3.googleusercontent.com/1", 100, 100], 1, "d", 0, {{}}], ["P_P" + page, ["https://lh3.googleusercontent.com/2", 100, 100], 1, "d", 0, {{}}]],
              page === 1 ? "PAGE2" : null
            ]);
            return {{ ok: true, status: 200, text: async () => ")]}}'\\n" + JSON.stringify([["wrb.fr", "snAcKc", inner]]) }};
          }};
          const multiRes = await sel.enumerateCurrentAlbum();
          if (JSON.stringify(multiRes.ids) !== JSON.stringify(["P_DUP", "P_P1", "P_P2"])) {{
            throw new Error("Expected multi-page RPC dedupe, got: " + JSON.stringify(multiRes));
          }}

          // 3. ds:7 script ownership classification
          sel.clearAll();
          mockScripts = [{{
            textContent: "AF_initDataCallback({{key: 'ds:7', data: [\\"DS7_OWNED\\",1,[\\"AF1QipViewerActor0000000001\\"],[[1],\\"lib\\"],\\"DS7_UNOWNED\\",1,[\\"AF1QipOtherActor00000000002\\"],null]}});"
          }}];
          const makeBareTile = (id, ownerTxt) => {{
            const link = {{
              getAttribute: (k) => (k === "href" ? "/photo/" + id : null),
              contains: () => false,
              parentElement: {{
                querySelectorAll: () => (ownerTxt ? [{{ children: [], textContent: ownerTxt }}] : [])
              }}
            }};
            return {{
              getAttribute: () => null,
              querySelector: (s) => (s === 'a[href*="/photo/"]' ? link : null)
            }};
          }};
          if (sel.classifyAriaLabel("", makeBareTile("DS7_OWNED")) !== "eligible" || sel.classifyAriaLabel("", makeBareTile("DS7_UNOWNED")) !== "skipped_unowned") {{
            throw new Error("ds:7 ownership classification mismatch");
          }}

          // 4. Account-name fallback ownership
          sel.clearAll();
          mockScripts = [];
          mockAccountBtns = [{{ getAttribute: () => "Google Account: Alice Smith (alice@example.com)" }}];
          if (sel.classifyAriaLabel("", makeBareTile("ACC_BOB", "Bob Jones")) !== "skipped_unowned") {{
            throw new Error("Expected Bob Jones tile to be skipped_unowned for Alice Smith");
          }}
          if (sel.classifyAriaLabel("", makeBareTile("ACC_ALICE", "Alice")) !== "eligible") {{
            throw new Error("Expected Alice tile to be eligible for Alice Smith");
          }}

          // 5. MutationObserver ignores own UI mutations, batches childList scans, and resets on album change
          const makeCb = (id) => {{
            const link = {{ getAttribute: (k) => (k === "href" ? "/photo/" + id : k === "aria-label" ? "Photo - Oct 1" : null), parentElement: {{ querySelectorAll: () => [] }} }};
            return {{ getAttribute: (k) => (k === "role" ? "checkbox" : k === "aria-checked" ? "true" : null), querySelector: () => link }};
          }};
          mockChecked = [makeCb("M1")];
          sel.getEligibleIds();
          checkboxQueryCount = 0;
          observerCb([{{ type: "childList", target: {{ nodeType: 1, closest: (s) => (s.includes("wphoto-menu-card") ? {{}} : null) }}, addedNodes: [{{}}], removedNodes: [] }}]);
          if (checkboxQueryCount !== 0) throw new Error("Own-UI mutation triggered checkbox scan");
          observerCb([
            {{ type: "childList", target: {{ nodeType: 1, closest: () => null }}, addedNodes: [{{}}], removedNodes: [] }},
            {{ type: "childList", target: {{ nodeType: 1, closest: () => null }}, addedNodes: [{{}}], removedNodes: [] }}
          ]);
          if (checkboxQueryCount !== 1) throw new Error("Expected batched childList mutations to scan once, got " + checkboxQueryCount);
          mockChecked = [];
          globalThis.location.pathname = "/album/OTHER_ALBUM";
          observerCb([]);
          if (sel.getEligibleIds().length !== 0) throw new Error("Expected album navigation to clear selection registry");

          print("SEL_02_OK");
        }})();
        """
        assert "SEL_02_OK" in run_jsc(js)

    runner.run_test(
        "SEL-02",
        "RPC timeout/HTTP fallback, multi-page dedupe, ds:7 & account ownership, and MutationObserver batching",
        sel_02,
    )

    # -------------------------------------------------------------------------
    # Suite 4: Info Panel Anti-Flap, Metadata & Caption Persistence
    # -------------------------------------------------------------------------
    print("\n--- Suite 4: Info Panel Anti-Flap, Metadata & Caption Persistence ---")

    def dom_01():
        js = f"""
        globalThis.window = globalThis;
        globalThis.PointerEvent = class {{ constructor(t) {{ this.type = t; }} }};
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        let panelOpen = false;
        let placeholderClicked = false;
        let cdpCommands = [];

        const mockTextarea = {{
          tagName: "TEXTAREA",
          value: "",
          getBoundingClientRect: () => ({{ left: 100, top: 200, width: 200, height: 40 }})
        }};

        const mockPlaceholder = {{
          tagName: "DIV",
          offsetParent: {{}},
          click() {{
            placeholderClicked = true;
          }}
        }};

        const mockInfoPanelRoot = {{
          offsetParent: {{}},
          innerText: "Details\\nOct 14, 2021\\nVenice, Metropolitan City of Venice, Italy\\n© Google",
          querySelectorAll(sel) {{
            if (sel === "a") {{
              return [
                {{
                  getAttribute: (k) => (k === "href" ? "/search/people_1" : ""),
                  querySelector: (s) => (s === "img" ? {{}} : null),
                  textContent: "Marie Curie"
                }},
                {{
                  getAttribute: (k) => (k === "href" ? "/search/people_untagged" : ""),
                  querySelector: (s) => (s === "img" ? {{}} : null),
                  textContent: ""
                }}
              ];
            }}
            return [];
          }},
          querySelector(sel) {{
            if (sel.includes("maps")) {{
              return {{
                parentElement: {{
                  innerText: "Add a location\\nVenice, Metropolitan City of Venice, Italy\\n© 2026",
                  parentElement: null
                }}
              }};
            }}
            return null;
          }},
          closest: () => mockInfoPanelRoot
        }};

        globalThis.chrome = {{
          runtime: {{
            lastError: null,
            sendMessage(msg, cb) {{
              cdpCommands.push(msg);
              if (msg.type === "BATCH_DISPATCH_CLICK_AT") {{
                globalThis.document.activeElement = mockTextarea;
              }} else if (msg.type === "BATCH_INSERT_TEXT") {{
                mockTextarea.value = msg.text;
              }} else if (msg.type === "BATCH_AWAIT_SAVE_QUIESCENCE") {{
                return cb({{ ok: true, saveXhrsObserved: 1, waitMs: 50 }});
              }}
              cb({{ ok: true }});
            }}
          }}
        }};

        globalThis.document = {{
          activeElement: null,
          querySelector(sel) {{
            if (sel.includes("Close info")) return panelOpen ? {{}} : null;
            if (sel.includes("Open info")) {{
              return {{
                offsetParent: {{}},
                dispatchEvent: () => {{}},
                click: () => {{ panelOpen = true; }},
                getBoundingClientRect: () => ({{ left: 10, top: 10, width: 20, height: 20 }})
              }};
            }}
            return null;
          }},
          querySelectorAll(sel) {{
            if (sel === "dl") return [mockInfoPanelRoot];
            if (sel.startsWith("textarea[")) return placeholderClicked ? [mockTextarea] : [];
            if (sel.startsWith('[aria-label="Add a description"]')) return [mockPlaceholder];
            return [];
          }}
        }};

        load({dom_file});
        const dom = window.WPhotoDomCaption;

        (async () => {{
          const meta = dom.extractMetadataOnce();
          if (meta.people[0] !== "Marie Curie" || meta.untaggedCount !== 1 || meta.location !== "Venice, Metropolitan City of Venice, Italy" || meta.year !== "2021") {{
            throw new Error("Metadata extraction mismatch: " + JSON.stringify(meta));
          }}

          const res1 = await dom.runCaption({{ text: "Marie in Venice.", overwrite: false }});
          if (!res1.success || !placeholderClicked || mockTextarea.value !== "Marie in Venice.") {{
            throw new Error("runCaption first write failed: " + JSON.stringify(res1));
          }}

          const resSkip = await dom.runCaption({{ text: "New description.", overwrite: false }});
          if (resSkip.success || resSkip.error !== "skipped_existing_description" || mockTextarea.value !== "Marie in Venice.") {{
            throw new Error("Overwrite=false failed to skip: " + JSON.stringify(resSkip));
          }}

          const resReplace = await dom.runCaption({{ text: "Updated description.", overwrite: true }});
          if (!resReplace.success || mockTextarea.value !== "Updated description.") {{
            throw new Error("Overwrite=true failed to replace: " + JSON.stringify(resReplace));
          }}

          print("DOM_01_OK");
        }})();
        """
        assert "DOM_01_OK" in run_jsc(js)

    runner.run_test(
        "DOM-01",
        "Info panel open, collapsed placeholder activation, metadata extraction, and overwrite=no/yes",
        dom_01,
    )

    def dom_02():
        js = f"""
        globalThis.window = globalThis;
        globalThis.PointerEvent = class {{ constructor(t) {{ this.type = t; }} }};

        let fakeClock = 0;
        let openCallCount = 0;
        globalThis.performance = {{ now: () => fakeClock }};
        globalThis.setTimeout = (fn, ms) => {{
          fakeClock += (ms || 50);
          Promise.resolve().then(fn);
          return 1;
        }};
        globalThis.clearTimeout = () => {{}};

        const mockTextarea = {{
          tagName: "TEXTAREA",
          value: "",
          getBoundingClientRect: () => ({{ left: 50, top: 50, width: 100, height: 30 }})
        }};

        globalThis.chrome = {{
          runtime: {{
            lastError: null,
            sendMessage(msg, cb) {{
              if (msg.type === "BATCH_DISPATCH_CLICK_AT") {{
                globalThis.document.activeElement = mockTextarea;
              }} else if (msg.type === "BATCH_INSERT_TEXT") {{
                mockTextarea.value = msg.text;
              }} else if (msg.type === "BATCH_AWAIT_SAVE_QUIESCENCE") {{
                return cb({{ ok: true, saveXhrsObserved: 1, waitMs: 20 }});
              }}
              cb({{ ok: true }});
            }}
          }}
        }};

        globalThis.document = {{
          activeElement: null,
          querySelector(sel) {{
            if (sel.includes("Close info")) {{
              openCallCount++;
              return {{}};
            }}
            return null;
          }},
          querySelectorAll(sel) {{
            // Textarea only mounts after the >2500ms proactive re-open triggers
            if (sel.startsWith("textarea[") && fakeClock >= 2700) return [mockTextarea];
            return [];
          }}
        }};

        load({dom_file});
        const dom = window.WPhotoDomCaption;

        (async () => {{
          const res = await dom.runCaption({{ text: "Recovered after flap.", overwrite: false }});
          if (!res.success || openCallCount < 2 || mockTextarea.value !== "Recovered after flap.") {{
            throw new Error("Expected anti-flap re-open at +2500ms to recover textarea, got: " + JSON.stringify(res));
          }}
          print("DOM_02_OK");
        }})();
        """
        assert "DOM_02_OK" in run_jsc(js)

    runner.run_test(
        "DOM-02",
        "Proactive anti-flap re-opening at +2500ms when textarea fails to mount on initial transition",
        dom_02,
    )

    def dom_03():
        js = f"""
        globalThis.window = globalThis;
        globalThis.PointerEvent = class {{ constructor(t) {{ this.type = t; }} }};

        let fakeClock = 0;
        let infoBtnClicks = 0;
        let closeBtnVisible = false;
        let closeBtnExistsHidden = true;

        globalThis.performance = {{ now: () => fakeClock }};
        globalThis.setTimeout = (fn, ms) => {{
          fakeClock += (ms || 50);
          Promise.resolve().then(fn);
          return 1;
        }};
        globalThis.clearTimeout = () => {{}};

        const sessionStore = {{ "__wphotoPanelOpen": "1" }};
        globalThis.sessionStorage = {{
          getItem: (k) => sessionStore[k] || null,
          setItem: (k, v) => {{ sessionStore[k] = String(v); }}
        }};

        globalThis.document = {{
          activeElement: null,
          querySelector(sel) {{
            if (sel.includes("Close info")) {{
              // Simulate slow natural hydration at +400ms
              if (fakeClock >= 400) closeBtnVisible = true;
              if (closeBtnVisible) {{
                return {{
                  offsetParent: {{}},
                  getBoundingClientRect: () => ({{ left: 10, top: 10, width: 24, height: 24 }})
                }};
              }}
              if (closeBtnExistsHidden) {{
                return {{
                  offsetParent: null,
                  getBoundingClientRect: () => ({{ left: 0, top: 0, width: 0, height: 0 }})
                }};
              }}
              return null;
            }}
            if (sel.includes("Open info")) {{
              return {{
                offsetParent: {{}},
                dispatchEvent: () => {{}},
                click: () => {{
                  infoBtnClicks++;
                  closeBtnVisible = !closeBtnVisible;
                }},
                getBoundingClientRect: () => ({{ left: 10, top: 10, width: 24, height: 24 }})
              }};
            }}
            return null;
          }},
          querySelectorAll() {{ return []; }}
        }};

        load({dom_file});
        const dom = window.WPhotoDomCaption;

        (async () => {{
          // 1. Hidden Close Info button (offsetParent: null) must NOT report panel as open
          if (dom.isInfoPanelOpen() !== false) {{
            throw new Error("Hidden Close info button should not make isInfoPanelOpen() return true");
          }}

          // 2. Remembered panel in sessionStorage waits for natural hydration (+400ms) without clicking Info button
          const resHydrate = await dom.ensureInfoPanelOpen();
          if (!resHydrate.ok || infoBtnClicks !== 0) {{
            throw new Error("Expected remembered panel to hydrate without clicking Info button, clicks=" + infoBtnClicks);
          }}

          // 3. forceToggleIfNoTextarea=true forces a click when textarea is missing despite Close info being visible
          const resForce = await dom.ensureInfoPanelOpen({{ forceToggleIfNoTextarea: true }});
          if (infoBtnClicks === 0) {{
            throw new Error("Expected forceToggleIfNoTextarea to click Info button when textarea is missing");
          }}

          // 4. "Photo not found" page fast-fails with skipped_unowned instead of hanging on black screen
          globalThis.document.body = {{ innerText: "Photo not found" }};
          if (!dom.isPhotoNotFoundPage()) {{
            throw new Error("Expected isPhotoNotFoundPage() to return true when body shows 'Photo not found'");
          }}
          const resNotFound = await dom.ensureInfoPanelOpen();
          if (resNotFound.ok || resNotFound.error !== "skipped_unowned") {{
            throw new Error("Expected ensureInfoPanelOpen to fast-fail with skipped_unowned on Photo not found page");
          }}

          // 5. Multi-slide DOM: hidden previous slide node first in DOM order must not mask visible active slide node
          globalThis.document.body = {{ innerText: "" }};
          const hiddenSlideCloseBtn = {{
            offsetParent: null,
            getBoundingClientRect: () => ({{ left: 0, top: 0, width: 0, height: 0 }})
          }};
          const visibleSlideCloseBtn = {{
            offsetParent: {{}},
            getBoundingClientRect: () => ({{ left: 900, top: 20, width: 24, height: 24 }})
          }};
          globalThis.document.querySelector = () => hiddenSlideCloseBtn;
          globalThis.document.querySelectorAll = (sel) => {{
            if (sel.includes("Close info")) return [hiddenSlideCloseBtn, visibleSlideCloseBtn];
            return [];
          }};
          if (dom.isInfoPanelOpen() !== true) {{
            throw new Error("Expected isInfoPanelOpen() to detect visible Close info on active slide despite hidden first slide node");
          }}

          print("DOM_03_OK");
        }})();
        """
        assert "DOM_03_OK" in run_jsc(js)

    runner.run_test(
        "DOM-03",
        "Hidden Close-info rejection, remembered-panel hydration grace wait, and forced toggle when textarea missing",
        dom_03,
    )

    def dom_04():
        js = f"""
        globalThis.window = globalThis;
        globalThis.PointerEvent = class {{ constructor(t) {{ this.type = t; }} }};

        let fakeClock = 0;
        let timerSeq = 0;
        const activeTimers = new Set();
        globalThis.performance = {{ now: () => fakeClock }};
        globalThis.setTimeout = (fn, ms) => {{
          const id = ++timerSeq;
          activeTimers.add(id);
          Promise.resolve().then(() => {{
            if (!activeTimers.has(id)) return;
            activeTimers.delete(id);
            fakeClock += (ms || 50);
            fn();
          }});
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ activeTimers.delete(id); }};

        let panelOpen = false;
        let flapOnSettle = false;
        let openCheckCount = 0;
        let infoBtnPresent = true;
        let openViaKey = false;
        let openViaCdp = false;
        let sentMsgs = [];
        let svgBtn = {{ offsetParent: {{}}, getAttribute: () => null, getBoundingClientRect: () => ({{ left: 10, top: 10, width: 20, height: 20 }}) }};
        let svgPaths = [];

        const infoBtn = {{
          offsetParent: {{}},
          dispatchEvent: () => {{}},
          click: () => {{
            if (flapOnSettle) {{
              panelOpen = true;
              openCheckCount = 0;
            }}
          }},
          getBoundingClientRect: () => ({{ left: 10, top: 10, width: 20, height: 20 }})
        }};

        globalThis.chrome = {{
          runtime: {{
            lastError: null,
            sendMessage(msg, cb) {{
              sentMsgs.push(msg);
              if (msg.type === "BATCH_DISPATCH_KEY" && msg.key === "i" && openViaKey) panelOpen = true;
              if (msg.type === "BATCH_DISPATCH_CLICK_AT" && openViaCdp) panelOpen = true;
              cb({{ ok: true }});
            }}
          }}
        }};

        globalThis.document = {{
          activeElement: null,
          querySelector(sel) {{
            if (sel.includes("Close info")) {{
              if (flapOnSettle && panelOpen && ++openCheckCount >= 2) {{
                panelOpen = false;
                flapOnSettle = false;
              }}
              return panelOpen ? {{ offsetParent: {{}}, getBoundingClientRect: () => ({{ width: 24, height: 24 }}) }} : null;
            }}
            if (sel.includes("Open info")) return infoBtnPresent ? infoBtn : null;
            return null;
          }},
          querySelectorAll(sel) {{
            if (sel.includes("svg path")) return svgPaths;
            return [];
          }}
        }};

        load({dom_file});
        const dom = window.WPhotoDomCaption;

        (async () => {{
          // 1. Flap after direct click recovers via 'i' shortcut (KeyI / 73)
          flapOnSettle = true;
          openViaKey = true;
          const r1 = await dom.ensureInfoPanelOpen();
          const keyMsg = sentMsgs.find((m) => m.type === "BATCH_DISPATCH_KEY");
          if (!r1.ok || !keyMsg || keyMsg.key !== "i" || keyMsg.code !== "KeyI" || keyMsg.windowsVirtualKeyCode !== 73) {{
            throw new Error("Expected flap to recover via 'i' KeyI/73 shortcut: " + JSON.stringify({{ r1, sentMsgs }}));
          }}

          // 2. Direct click & 'i' fail -> CDP click fallback opens panel
          panelOpen = false;
          openViaKey = false;
          openViaCdp = true;
          sentMsgs = [];
          const r2 = await dom.ensureInfoPanelOpen();
          const cdpMsg = sentMsgs.find((m) => m.type === "BATCH_DISPATCH_CLICK_AT");
          if (!r2.ok || !cdpMsg || cdpMsg.x !== 20 || cdpMsg.y !== 20) {{
            throw new Error("Expected CDP click fallback at (20,20) to open panel: " + JSON.stringify({{ r2, sentMsgs }}));
          }}

          // 3. SVG path fallback in findInfoButton()
          infoBtnPresent = false;
          svgPaths = [{{ getAttribute: (k) => (k === "d" ? "M11 7h2v2h-2zm0 4h2v6h-2z" : ""), closest: () => svgBtn }}];
          if (dom.findInfoButton() !== svgBtn) {{
            throw new Error("Expected findInfoButton() SVG fallback to locate svgBtn");
          }}

          // 4. All strategies fail (5000ms CDP timeout) -> info_panel_did_not_open
          svgPaths = [];
          infoBtnPresent = true;
          panelOpen = false;
          openViaCdp = false;
          const r4 = await dom.ensureInfoPanelOpen();
          if (r4.ok || r4.error !== "info_panel_did_not_open") {{
            throw new Error("Expected info_panel_did_not_open timeout error: " + JSON.stringify(r4));
          }}

          // 5. Missing info button + failed 'i' -> info_button_not_found
          infoBtnPresent = false;
          panelOpen = false;
          const r5 = await dom.ensureInfoPanelOpen();
          if (r5.ok || r5.error !== "info_button_not_found") {{
            throw new Error("Expected info_button_not_found error: " + JSON.stringify(r5));
          }}

          // 6. Batch abort short-circuits ensureInfoPanelOpen without dispatching clicks/keys
          sentMsgs = [];
          globalThis.__wphotoIsBatchAborted = () => true;
          const r6 = await dom.ensureInfoPanelOpen();
          if (r6.ok || r6.error !== "batch_aborted" || sentMsgs.length !== 0) {{
            throw new Error("Expected batch_aborted with zero dispatches: " + JSON.stringify({{ r6, sentMsgs }}));
          }}

          print("DOM_04_OK");
        }})();
        """
        assert "DOM_04_OK" in run_jsc(js)

    def dom_05():
        js = f"""
        globalThis.window = globalThis;
        globalThis.PointerEvent = class {{ constructor(t) {{ this.type = t; }} }};

        let fakeClock = 0;
        let timerSeq = 0;
        const activeTimers = new Set();
        globalThis.performance = {{ now: () => fakeClock }};
        globalThis.setTimeout = (fn, ms) => {{
          const id = ++timerSeq;
          activeTimers.add(id);
          Promise.resolve().then(() => {{
            if (!activeTimers.has(id)) return;
            activeTimers.delete(id);
            fakeClock += (ms || 50);
            fn();
          }});
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ activeTimers.delete(id); }};

        let panelOpen = true;
        let videoPresent = false;
        let textareas = [];
        let dls = [];
        let focusOnClickNum = 999;
        let clickCount = 0;
        let failFirstInsertNotAttached = false;
        let quiesceReturnZeroOnce = false;
        let quiesceCalls = 0;
        let blurred = false;
        let sentMsgs = [];
        let locationReadyAt = 999999;

        globalThis.chrome = {{
          runtime: {{
            lastError: null,
            sendMessage(msg, cb) {{
              sentMsgs.push(msg);
              if (msg.type === "BATCH_DISPATCH_CLICK_AT") {{
                clickCount++;
                if (clickCount >= focusOnClickNum) globalThis.document.activeElement = textareas[0] || null;
              }} else if (msg.type === "BATCH_INSERT_TEXT") {{
                if (failFirstInsertNotAttached) {{
                  failFirstInsertNotAttached = false;
                  return cb({{ ok: false, error: "not_attached" }});
                }}
                if (textareas[0]) textareas[0].value = msg.text;
              }} else if (msg.type === "BATCH_AWAIT_SAVE_QUIESCENCE") {{
                quiesceCalls++;
                if (quiesceReturnZeroOnce) {{
                  quiesceReturnZeroOnce = false;
                  return cb({{ ok: true, saveXhrsObserved: 0, waitMs: 50 }});
                }}
                return cb({{ ok: true, saveXhrsObserved: 1, waitMs: 50 }});
              }}
              cb({{ ok: true }});
            }}
          }}
        }};

        globalThis.document = {{
          activeElement: null,
          querySelector(sel) {{
            if (sel === "video") return videoPresent ? {{}} : null;
            if (sel.includes("Close info")) return panelOpen ? {{ offsetParent: {{}}, getBoundingClientRect: () => ({{ width: 24, height: 24 }}) }} : null;
            return null;
          }},
          querySelectorAll(sel) {{
            if (sel.startsWith("textarea[")) return textareas;
            if (sel === "dl") return dls;
            return [];
          }}
        }};

        load({dom_file});
        const dom = window.WPhotoDomCaption;

        (async () => {{
          // 1. Textarea mount timeout (10s) -> textarea_not_visible
          const r1 = await dom.runCaption({{ text: "Test" }});
          if (r1.success || r1.error !== "textarea_not_visible") {{
            throw new Error("Expected textarea_not_visible timeout, got: " + JSON.stringify(r1));
          }}

          // 2. Video element present -> skipped_video
          videoPresent = true;
          const r2 = await dom.runCaption({{ text: "Test" }});
          if (r2.success || r2.error !== "skipped_video") {{
            throw new Error("Expected skipped_video, got: " + JSON.stringify(r2));
          }}
          videoPresent = false;

          // 3. Zero-rect collapse before initial click -> textarea_not_visible with ZERO clicks
          let rectReads = 0;
          sentMsgs = [];
          textareas = [{{
            tagName: "TEXTAREA",
            value: "",
            getBoundingClientRect: () => (++rectReads <= 2 ? {{ left: 50, top: 50, width: 100, height: 30 }} : {{ left: 0, top: 0, width: 0, height: 0 }})
          }}];
          const r3 = await dom.runCaption({{ text: "Test" }});
          if (r3.success || r3.error !== "textarea_not_visible" || sentMsgs.some((m) => m.type === "BATCH_DISPATCH_CLICK_AT")) {{
            throw new Error("Zero-rect textarea should abort before clicking: " + JSON.stringify({{ r3, sentMsgs }}));
          }}

          // 4. Focus retry exhaustion -> caption_focus_failed; recovery on 2nd click -> success
          textareas = [{{
            tagName: "TEXTAREA",
            value: "",
            getBoundingClientRect: () => ({{ left: 50, top: 50, width: 100, height: 30 }}),
            blur: () => {{ blurred = true; globalThis.document.activeElement = null; }}
          }}];
          clickCount = 0;
          focusOnClickNum = 999;
          const r4Fail = await dom.runCaption({{ text: "Test" }});
          if (r4Fail.success || r4Fail.error !== "caption_focus_failed" || clickCount < 3) {{
            throw new Error("Expected caption_focus_failed after retries: " + JSON.stringify({{ r4Fail, clickCount }}));
          }}

          // 5. Recovery on 2nd click + CDP not_attached auto-reattach + quiescence=0 blur + 2nd quiescence
          clickCount = 0;
          focusOnClickNum = 2;
          failFirstInsertNotAttached = true;
          quiesceReturnZeroOnce = true;
          quiesceCalls = 0;
          blurred = false;
          sentMsgs = [];
          const r5 = await dom.runCaption({{ text: "Saved after reattach" }});
          if (!r5.success || textareas[0].value !== "Saved after reattach" || !blurred || quiesceCalls !== 2 || !sentMsgs.some((m) => m.type === "BATCH_ATTACH" && m.forPhotoStep)) {{
            throw new Error("Expected focus recovery + reattach + blur retry: " + JSON.stringify({{ r5, blurred, quiesceCalls, val: textareas[0].value }}));
          }}

          // 6. isInfoPanelReadOnlyUnowned: false with textarea, true on Shared by / missing textarea timeout
          if ((await dom.isInfoPanelReadOnlyUnowned()) !== false) throw new Error("Expected read-only false when textarea visible");
          textareas = [];
          const roPanel = {{
            offsetParent: {{}},
            innerText: "Shared by Alice",
            closest: () => roPanel,
            querySelectorAll: (s) => (s === "dl, div, span" ? [{{ children: [], tagName: "DIV", textContent: "Shared by Alice" }}] : []),
            querySelector: () => null
          }};
          dls = [roPanel];
          if ((await dom.isInfoPanelReadOnlyUnowned()) !== true) throw new Error("Expected read-only true on Shared by panel");
          roPanel.innerText = "Details";
          roPanel.querySelectorAll = () => [];
          if ((await dom.isInfoPanelReadOnlyUnowned()) !== true) throw new Error("Expected read-only true when dl open and textarea absent");

          // 7. extractMetadataWithStabilization: waits for late location, and exits fast on abort
          fakeClock = 0;
          locationReadyAt = 400;
          const metaPanel = {{
            offsetParent: {{}},
            innerText: "Details\\n2023",
            closest: () => metaPanel,
            querySelectorAll: () => [],
            querySelector: (s) => (s.includes("maps") && fakeClock >= locationReadyAt ? {{ parentElement: {{ innerText: "Kyoto, Japan", parentElement: null }} }} : null)
          }};
          dls = [metaPanel];
          const meta = await dom.extractMetadataWithStabilization();
          if (meta.location !== "Kyoto, Japan") throw new Error("Expected stabilization to wait for Kyoto location: " + JSON.stringify(meta));
          globalThis.__wphotoIsBatchAborted = () => true;
          const clockBeforeAbort = fakeClock;
          await dom.extractMetadataWithStabilization();
          if (fakeClock !== clockBeforeAbort) throw new Error("Expected stabilization to stop immediately when aborted");

          print("DOM_05_OK");
        }})();
        """
        assert "DOM_05_OK" in run_jsc(js)

    runner.run_test(
        "DOM-04",
        "Info panel failures, flap fallback to 'i' shortcut & CDP click, SVG button fallback, timeout & abort",
        dom_04,
    )
    runner.run_test(
        "DOM-05",
        "Textarea timeout, video skip, zero-rect guard, focus retry, CDP reattach, quiescence blur & stabilization",
        dom_05,
    )

    # -------------------------------------------------------------------------
    # Suite 5: Cloud & Local AI Engine + Photo Stack Propagation
    # -------------------------------------------------------------------------
    print("\n--- Suite 5: Cloud & Local AI Engine + Photo Stack Propagation ---")

    def ai_01():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        let currentPhotoId = "STACK_TOP_1";
        let writtenCaptions = [];
        let lastGeminiPayload = null;
        let shouldFailCloud = false;

        globalThis.location = {{
          origin: "https://photos.google.com",
          get pathname() {{ return "/photo/" + currentPhotoId; }}
        }};

        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async (k) => (k === "geminiApiKey" ? {{ geminiApiKey: "TEST_KEY_123" }} : ({{}})),
              set: async () => {{}}
            }}
          }}
        }};

        globalThis.fetch = async (url, init) => {{
          if (shouldFailCloud) {{
            return {{ ok: false, status: 500, text: async () => "Internal Error" }};
          }}
          lastGeminiPayload = JSON.parse(init.body);
          return {{
            ok: true,
            status: 200,
            json: async () => ({{
              candidates: [
                {{
                  content: {{
                    parts: [
                      {{ thought: true, text: "Thinking..." }},
                      {{ text: "A photo of Marie examining a manuscript in Venice." }}
                    ]
                  }}
                }}
              ]
            }})
          }};
        }};

        globalThis.document = {{
          createElement(tag) {{
            if (tag === "canvas") {{
              return {{
                width: 0,
                height: 0,
                getContext: () => ({{ drawImage: () => {{}} }}),
                toDataURL: () => "data:image/jpeg;base64,FAKEB64DATA"
              }};
            }}
            return {{}};
          }},
          querySelector: () => null,
          querySelectorAll(sel) {{
            if (sel === "img") {{
              return [{{ src: "https://lh3.googleusercontent.com/photo1", naturalWidth: 1600, naturalHeight: 1200, offsetParent: {{}} }}];
            }}
            if (sel.includes('button[aria-label*="Photo "]')) {{
              return [
                {{
                  offsetParent: {{}},
                  querySelector: () => ({{}}),
                  getBoundingClientRect: () => ({{ height: 80 }}),
                  getAttribute: (k) => (k === "aria-selected" ? (currentPhotoId === "STACK_TOP_1" ? "true" : "false") : "Photo 1")
                }},
                {{
                  offsetParent: {{}},
                  querySelector: () => ({{}}),
                  getBoundingClientRect: () => ({{ height: 80 }}),
                  getAttribute: (k) => (k === "aria-selected" ? (currentPhotoId === "STACK_SUB_2" ? "true" : "false") : "Photo 2"),
                  click() {{
                    currentPhotoId = "STACK_SUB_2";
                  }}
                }}
              ];
            }}
            return [];
          }}
        }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        window.WPhotoDomCaption.ensureInfoPanelOpen = async () => ({{ ok: true }});
        window.WPhotoDomCaption.findVisibleDescriptionTextarea = () => ({{ value: "" }});
        window.WPhotoDomCaption.extractMetadataWithStabilization = async () => ({{
          people: ["Marie Curie"],
          untaggedCount: 0,
          location: "Venice, Metropolitan City of Venice, Italy",
          year: "2023"
        }});
        window.WPhotoDomCaption.runCaption = async ({{ text }}) => {{
          writtenCaptions.push({{ photoId: currentPhotoId, text }});
          return {{
            success: true,
            timing: {{ textareaVisibleMs: 10, focusToInsertMs: 20, blurToSettleMs: 30, retried: false }}
          }};
        }};

        (async () => {{
          // 1. Successful Cloud run + Stack Propagation
          const res = await window.WPhotoAiEngine.runAiDescription({{
            photoId: "STACK_TOP_1",
            lang: "en",
            model: "cloud",
            overwrite: false,
            verbose: false
          }});

          if (!res.success) throw new Error("runAiDescription failed: " + JSON.stringify(res));
          if (writtenCaptions.length !== 2) {{
            throw new Error("Expected stack propagation to write 2 captions, got: " + JSON.stringify(writtenCaptions));
          }}
          if (writtenCaptions[0].text !== "Marie examining a manuscript in Venice." || writtenCaptions[1].text !== "Marie examining a manuscript in Venice.") {{
            throw new Error("Cleaned caption mismatch: " + JSON.stringify(writtenCaptions));
          }}
          const extra = JSON.parse(res.errorDetail);
          if (JSON.stringify(extra.extraCompletedIds) !== JSON.stringify(["STACK_SUB_2"])) {{
            throw new Error("extraCompletedIds mismatch: " + res.errorDetail);
          }}
          if (!lastGeminiPayload.system_instruction) {{
            throw new Error("system_instruction missing from Gemini payload");
          }}

          // 2. Cloud failure strictly skips without falling back to metadata
          shouldFailCloud = true;
          const resFail = await window.WPhotoAiEngine.runAiDescription({{
            photoId: "STACK_TOP_1",
            lang: "en",
            model: "cloud",
            overwrite: false,
            verbose: false
          }});
          if (resFail.success || resFail.error !== "skipped_cloud_error") {{
            throw new Error("Expected skipped_cloud_error on cloud failure, got: " + JSON.stringify(resFail));
          }}

          print("AI_01_OK");
        }})();
        """
        assert "AI_01_OK" in run_jsc(js)

    runner.run_test(
        "AI-01",
        "Cloud Gemini 768x768 resize, thought filtering, strict cloud skip on error, and stack propagation",
        ai_01,
    )

    def ai_02():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};
        globalThis.location = {{ origin: "https://photos.google.com", pathname: "/photo/LOC_1" }};

        let messageListeners = [];
        globalThis.addEventListener = (ev, fn) => {{
          if (ev === "message") messageListeners.push(fn);
        }};
        globalThis.removeEventListener = (ev, fn) => {{
          messageListeners = messageListeners.filter((f) => f !== fn);
        }};
        globalThis.postMessage = (data) => {{
          if (data && data.ns === "wphotoNano") {{
            Promise.resolve().then(() => {{
              const reply = data.op === "probe"
                ? {{ ns: "wphotoNanoReply", id: data.id, status: "unavailable" }}
                : {{ ns: "wphotoNanoReply", id: data.id, error: "no_api" }};
              for (const fn of [...messageListeners]) {{
                fn({{ source: globalThis.window, data: reply }});
              }}
            }});
          }}
        }};

        let logStorage = "";
        globalThis.chrome = {{
          storage: {{
            local: {{
              get: (k, cb) => {{
                const res = {{ aiDescriptionVerboseLog: logStorage }};
                if (cb) cb(res);
                return Promise.resolve(res);
              }},
              set: (obj, cb) => {{
                if ("aiDescriptionVerboseLog" in obj) logStorage = obj.aiDescriptionVerboseLog;
                if (cb) cb();
                return Promise.resolve();
              }}
            }}
          }},
          runtime: {{
            sendMessage: (msg, cb) => cb && cb({{ ok: true }})
          }}
        }};

        globalThis.document = {{
          querySelector: () => null,
          querySelectorAll: (sel) => (sel === "img" ? [{{ src: "https://lh3.googleusercontent.com/p", naturalWidth: 800, naturalHeight: 600, offsetParent: {{}} }}] : [])
        }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        let savedText = null;
        window.WPhotoDomCaption.ensureInfoPanelOpen = async () => ({{ ok: true }});
        window.WPhotoDomCaption.findVisibleDescriptionTextarea = () => ({{ value: "" }});
        window.WPhotoDomCaption.extractMetadataWithStabilization = async () => ({{
          people: ["Jean Dupont", "Claire Martin"],
          untaggedCount: 0,
          location: "Lyon",
          year: "2022"
        }});
        window.WPhotoDomCaption.runCaption = async ({{ text }}) => {{
          savedText = text;
          return {{
            success: true,
            timing: {{ textareaVisibleMs: 5, focusToInsertMs: 10, blurToSettleMs: 15, retried: false }}
          }};
        }};

        (async () => {{
          const res = await window.WPhotoAiEngine.runAiDescription({{
            photoId: "LOC_1",
            lang: "fr",
            model: "local",
            overwrite: false,
            verbose: true
          }});
          if (!res.success || savedText !== "Jean et Claire à Lyon, 2022.") {{
            throw new Error("Local metadata fallback in French failed: " + savedText);
          }}
          if (!logStorage.includes("LOC_1") || !logStorage.includes("[metadata_fetch_start]") || !logStorage.includes("Jean et Claire à Lyon, 2022.")) {{
            throw new Error("Verbose log missing expected entries: " + logStorage);
          }}
          await window.WPhotoAiEngine.clearAiDescLog();
          if (logStorage !== "") throw new Error("clearAiDescLog did not clear log");

          print("AI_02_OK");
        }})();
        """
        assert "AI_02_OK" in run_jsc(js)

    runner.run_test(
        "AI-02",
        "Local model bridge probe, metadata fallback (EN/FR/ES), and granular verbose logging",
        ai_02,
    )

    def ai_03():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        let fetchAttempt = 0;
        let retryEvents = [];
        let always429 = false;

        globalThis.fetch = async () => {{
          fetchAttempt++;
          if (always429 || fetchAttempt <= 2) {{
            return {{
              ok: false,
              status: 429,
              headers: {{ get: (h) => (h.toLowerCase() === "retry-after" ? "3" : null) }},
              text: async () => "Resource has been exhausted (e.g. check quota)."
            }};
          }}
          return {{
            ok: true,
            status: 200,
            json: async () => ({{
              candidates: [
                {{
                  content: {{
                    parts: [{{ text: "A sunlit plaza in Madrid." }}]
                  }}
                }}
              ]
            }})
          }};
        }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        (async () => {{
          // Case 1: 2x HTTP 429 followed by 200 OK -> succeeds after 2 retries
          const resOk = await window.WPhotoAiEngine.callGeminiCloud({{
            apiKey: "TEST_KEY_429",
            rules: "No people.",
            instruction: "Describe.",
            lang: "en",
            retryDelaysMs: [10, 20, 30],
            onRetry: (attempt, waitMs) => retryEvents.push({{ attempt, waitMs }})
          }});

          if (resOk.error || resOk.text !== "A sunlit plaza in Madrid." || resOk.retries429 !== 2) {{
            throw new Error("Expected 429 backoff recovery on attempt 3, got: " + JSON.stringify(resOk));
          }}
          if (retryEvents.length !== 2 || retryEvents[0].waitMs !== 10 || retryEvents[1].waitMs !== 20) {{
            throw new Error("Unexpected retryEvents: " + JSON.stringify(retryEvents));
          }}

          // Case 2: Persistent HTTP 429 exhausts all 3 retries (4 total calls) and returns gemini_api_error_429
          fetchAttempt = 0;
          always429 = true;
          const resExhausted = await window.WPhotoAiEngine.callGeminiCloud({{
            apiKey: "TEST_KEY_429",
            rules: "No people.",
            instruction: "Describe.",
            lang: "en",
            retryDelaysMs: [5, 5, 5]
          }});
          if (!resExhausted.error || !resExhausted.error.startsWith("gemini_api_error_429") || resExhausted.retries429 !== 3 || fetchAttempt !== 4) {{
            throw new Error("Expected exhausted 429 after 3 retries (4 calls), got: " + JSON.stringify({{ resExhausted, fetchAttempt }}));
          }}

          // Case 3: Network AbortError when batch is NOT aborted -> gemini_fetch_timeout (not batch_aborted)
          globalThis.fetch = async () => {{
            const err = new Error("timed out");
            err.name = "AbortError";
            throw err;
          }};
          const resTimeout = await window.WPhotoAiEngine.callGeminiCloud({{
            apiKey: "TEST_KEY_429",
            rules: "",
            instruction: "Describe.",
            lang: "en"
          }});
          if (resTimeout.error !== "gemini_fetch_timeout") {{
            throw new Error("Expected gemini_fetch_timeout on AbortError when not aborted, got: " + JSON.stringify(resTimeout));
          }}

          print("AI_03_OK");
        }})();
        """
        assert "AI_03_OK" in run_jsc(js)

    runner.run_test(
        "AI-03",
        "Cloud Gemini HTTP 429 rate-limit exponential backoff recovery and max-retry exhaustion",
        ai_03,
    )

    def ai_04():
        js = f"""
        globalThis.window = globalThis;
        globalThis.innerWidth = 1280;
        globalThis.innerHeight = 800;
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        // Simulate a Photo Stack where navigating to STACK_ENTRY_1 redirects to Top Pick STACK_TOP_2
        let currentPhotoId = "STACK_TOP_2";
        let cdpClicks = [];
        let fetchUrls = [];
        let sharedTextarea = {{
          value: "",
          offsetParent: {{}},
          getBoundingClientRect: () => ({{ left: 950, top: 200, width: 280, height: 60 }})
        }};
        let insertedTexts = [];

        globalThis.location = {{
          origin: "https://photos.google.com",
          get pathname() {{ return "/photo/" + currentPhotoId; }}
        }};

        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async (k) => (k === "geminiApiKey" ? {{ geminiApiKey: "TEST_KEY_STACK" }} : ({{}})),
              set: async () => {{}}
            }}
          }},
          runtime: {{
            sendMessage: (msg, cb) => {{
              if (msg.type === "BATCH_DISPATCH_CLICK_AT") {{
                cdpClicks.push({{ x: msg.x, y: msg.y }});
                // Clicking thumb 1 at x=525, y=725 switches from STACK_TOP_2 back to STACK_ENTRY_1
                if (msg.x >= 490 && msg.x <= 560 && msg.y >= 690 && msg.y <= 760) {{
                  currentPhotoId = "STACK_ENTRY_1";
                }} else {{
                  globalThis.document.activeElement = sharedTextarea;
                }}
              }}
              if (msg.type === "BATCH_INSERT_TEXT") {{
                sharedTextarea.value = msg.text;
                insertedTexts.push({{ photoId: currentPhotoId, text: msg.text }});
              }}
              cb({{ ok: true }});
            }}
          }}
        }};

        globalThis.fetch = async (url, init) => {{
          fetchUrls.push(url);
          if (url.includes("gemini-3.1-flash-lite:")) {{
            return {{ ok: false, status: 404, text: async () => "Not Found" }};
          }}
          const body = JSON.parse(init.body);
          if (!body.generationConfig?.thinkingConfig || body.generationConfig.thinkingConfig.thinkingBudget !== 0) {{
            throw new Error("Expected thinkingBudget=0 in generationConfig");
          }}
          return {{
            ok: true,
            status: 200,
            json: async () => ({{
              candidates: [
                {{
                  content: {{
                    parts: [{{ text: "Panoramique sur la Mayenne et les ponts de Laval." }}]
                  }}
                }}
              ]
            }})
          }};
        }};

        // Bottom filmstrip thumbnails using div[role="button"] + background-image (Strategy 4 geometric discovery)
        const thumb1 = {{
          tagName: "DIV",
          offsetParent: {{}},
          style: {{ backgroundImage: 'url("https://lh3.googleusercontent.com/t1")' }},
          getAttribute: (k) => (k === "role" ? "button" : null),
          getBoundingClientRect: () => ({{ left: 500, top: 700, right: 550, bottom: 750, width: 50, height: 50 }}),
          querySelector: () => null,
          contains: () => false
          // Note: no .click() effect -> requires CDP BATCH_DISPATCH_CLICK_AT fallback!
        }};
        const thumb2 = {{
          tagName: "DIV",
          offsetParent: {{}},
          style: {{ backgroundImage: 'url("https://lh3.googleusercontent.com/t2")' }},
          getAttribute: (k) => (k === "role" ? "button" : (k === "aria-selected" ? (currentPhotoId === "STACK_TOP_2" ? "true" : "false") : null)),
          getBoundingClientRect: () => ({{ left: 565, top: 700, right: 615, bottom: 750, width: 50, height: 50 }}),
          querySelector: () => null,
          contains: () => false
        }};
        // Info panel avatar inside <dl> on the right should be excluded by isInsideInfoPanel
        const infoPanelAvatar = {{
          tagName: "IMG",
          offsetParent: {{}},
          naturalWidth: 48,
          naturalHeight: 48,
          getBoundingClientRect: () => ({{ left: 1020, top: 700, right: 1068, bottom: 748, width: 48, height: 48 }}),
          closest: (sel) => (sel.includes("dl") ? ({{}}) : null),
          contains: () => false
        }};

        globalThis.document = {{
          createElement(tag) {{
            if (tag === "canvas") {{
              return {{
                width: 0,
                height: 0,
                getContext: () => ({{ drawImage: () => {{}} }}),
                toDataURL: () => "data:image/jpeg;base64,FAKEB64"
              }};
            }}
            return {{}};
          }},
          querySelector(sel) {{
            if (sel.includes("Close info")) {{
              return {{ offsetParent: {{}}, getBoundingClientRect: () => ({{ width: 24, height: 24 }}) }};
            }}
            return null;
          }},
          querySelectorAll(sel) {{
            if (sel === "img") {{
              return [
                {{ src: "https://lh3.googleusercontent.com/main=w1200-h900", naturalWidth: 1200, naturalHeight: 900, offsetParent: {{}} }},
                infoPanelAvatar
              ];
            }}
            if (sel.includes("textarea")) {{
              return [sharedTextarea];
            }}
            if (sel.includes('[style*="background-image"]')) {{
              return [thumb1, thumb2, infoPanelAvatar];
            }}
            return [];
          }}
        }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        window.WPhotoDomCaption.extractMetadataWithStabilization = async () => ({{
          people: [],
          untaggedCount: 0,
          location: "Laval, France",
          year: "2024"
        }});

        (async () => {{
          const detected = window.WPhotoAiEngine.findStackThumbs();
          if (detected.length !== 2) {{
            throw new Error("Expected geometric findStackThumbs to find 2 bottom-strip thumbs (excluding Info panel), got: " + detected.length);
          }}

          const res1 = await window.WPhotoAiEngine.runAiDescription({{
            photoId: "STACK_ENTRY_1",
            lang: "fr",
            model: "cloud",
            overwrite: false,
            verbose: false
          }});

          if (!res1.success) {{
            throw new Error("Expected stack runAiDescription to succeed, got: " + JSON.stringify(res1));
          }}
          if (insertedTexts.length !== 2) {{
            throw new Error("Expected both STACK_TOP_2 and redirected-from STACK_ENTRY_1 to be captioned via forceWrite, got: " + JSON.stringify(insertedTexts));
          }}
          if (insertedTexts[0].photoId !== "STACK_TOP_2" || insertedTexts[1].photoId !== "STACK_ENTRY_1") {{
            throw new Error("Unexpected stack caption order: " + JSON.stringify(insertedTexts));
          }}
          if (insertedTexts[0].text !== insertedTexts[1].text) {{
            throw new Error("Expected identical caption for both stack photos");
          }}
          // Verify model was only called ONCE for the 2-photo stack (1x 404 + 1x 200 on first run)
          if (fetchUrls.length !== 2) {{
            throw new Error("Expected model to be called only once for the stack, got: " + JSON.stringify(fetchUrls));
          }}

          // Verify prefilledCaption reuses the exact same text without calling fetch at all
          fetchUrls = [];
          insertedTexts = [];
          currentPhotoId = "STACK_ENTRY_1";
          const resPrefilled = await window.WPhotoAiEngine.runAiDescription({{
            photoId: "STACK_ENTRY_1",
            lang: "fr",
            model: "cloud",
            overwrite: true,
            prefilledCaption: "Panoramique sur la Mayenne et les ponts de Laval.",
            alreadyCompletedIds: ["STACK_TOP_2"],
            verbose: false
          }});
          if (!resPrefilled.success || fetchUrls.length !== 0 || resPrefilled.timing.generateMs !== 0 || insertedTexts.length !== 1) {{
            throw new Error("Expected prefilledCaption to skip AI model call and write same text once: " + JSON.stringify({{ resPrefilled, fetchUrls, insertedTexts }}));
          }}

          // Second cloud call should use cached gemini-3.1-flash-lite-preview directly without 404ing on gemini-3.1-flash-lite
          fetchUrls = [];
          await window.WPhotoAiEngine.callGeminiCloud({{
            apiKey: "TEST_KEY_STACK",
            rules: "",
            instruction: "Describe.",
            lang: "fr"
          }});
          if (fetchUrls.length !== 1 || !fetchUrls[0].includes("gemini-3.1-flash-lite-preview")) {{
            throw new Error("Expected cachedWorkingCloudModel to call preview directly in 1 request, got: " + JSON.stringify(fetchUrls));
          }}

          print("AI_04_OK");
        }})();
        """
        assert "AI_04_OK" in run_jsc(js)

    runner.run_test(
        "AI-04",
        "Photo stack Top-Pick redirect, geometric strip detection, CDP click fallback, forceWrite, and model caching",
        ai_04,
    )

    def ai_05():
        js = f"""
        globalThis.window = globalThis;
        let fakeClock = 0;
        let timerSeq = 0;
        const activeTimers = new Set();
        globalThis.performance = {{ now: () => fakeClock }};
        globalThis.setTimeout = (fn, ms) => {{
          const id = ++timerSeq;
          activeTimers.add(id);
          Promise.resolve().then(() => {{
            if (!activeTimers.has(id)) return;
            activeTimers.delete(id);
            fakeClock += (ms || 50);
            fn();
          }});
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ activeTimers.delete(id); }};
        globalThis.location = {{ origin: "https://photos.google.com", pathname: "/photo/P_ERR" }};

        let listenerDelta = 0;
        globalThis.addEventListener = () => {{ listenerDelta++; }};
        globalThis.removeEventListener = () => {{ listenerDelta--; }};

        let fetchCount = 0;
        let hasMainImg = true;
        let hasVideo = false;
        let apiKey = "KEY_OK";
        globalThis.fetch = async () => {{ fetchCount++; return {{ ok: true, status: 200, json: async () => ({{}}) }}; }};
        globalThis.chrome = {{
          storage: {{ local: {{ get: async () => (apiKey ? {{ geminiApiKey: apiKey }} : ({{}})), set: async () => {{}} }} }}
        }};
        globalThis.document = {{
          querySelector: (s) => (s === "video" && hasVideo ? {{}} : null),
          querySelectorAll: (s) => (s === "img" && hasMainImg ? [{{ src: "https://lh3.googleusercontent.com/main", naturalWidth: 1200, naturalHeight: 800, offsetParent: {{}} }}] : [])
        }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        let panelRes = {{ ok: true }};
        let panelCalls = 0;
        let readOnlyUnowned = false;
        let notFoundPage = false;
        let throwInPanel = false;
        window.WPhotoDomCaption.isPhotoNotFoundPage = () => notFoundPage;
        window.WPhotoDomCaption.isInfoPanelReadOnlyUnowned = async () => readOnlyUnowned;
        window.WPhotoDomCaption.findVisibleDescriptionTextarea = () => ({{ value: "" }});
        window.WPhotoDomCaption.extractMetadataWithStabilization = async () => ({{ people: [], untaggedCount: 0, location: null, year: null }});
        window.WPhotoDomCaption.ensureInfoPanelOpen = async () => {{
          panelCalls++;
          if (throwInPanel) throw new Error("dom_crash");
          return panelRes;
        }};

        (async () => {{
          // 1. info_panel_did_not_open propagates with 0 Gemini fetches
          panelRes = {{ ok: false, error: "info_panel_did_not_open", detail: "timeout" }};
          const r1 = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          if (r1.success || r1.error !== "info_panel_did_not_open" || fetchCount !== 0) {{
            throw new Error("Expected info_panel_did_not_open propagation: " + JSON.stringify({{ r1, fetchCount }}));
          }}

          // 2. info_button_not_found with vs without main image
          panelRes = {{ ok: false, error: "info_button_not_found" }};
          const r2WithImg = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          if (r2WithImg.error !== "info_button_not_found") throw new Error("Expected info_button_not_found when img present");
          hasMainImg = false;
          fakeClock = 0;
          const r2NoImg = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          if (r2NoImg.error !== "skipped_unowned" || fakeClock >= 2000) {{
            throw new Error("Expected skipped_unowned and early ~1200ms pre-hydrate break: " + JSON.stringify({{ r2NoImg, fakeClock }}));
          }}

          // 3. Read-only unowned panel skips before cloud fetch
          hasMainImg = true;
          panelRes = {{ ok: true }};
          readOnlyUnowned = true;
          const r3 = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          if (r3.error !== "skipped_unowned" || fetchCount !== 0) throw new Error("Expected skipped_unowned on read-only panel");
          readOnlyUnowned = false;

          // 4. Video and not-found fast-fails avoid calling ensureInfoPanelOpen
          panelCalls = 0;
          hasVideo = true;
          const rVid = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          hasVideo = false;
          notFoundPage = true;
          const rNf = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          notFoundPage = false;
          if (rVid.error !== "skipped_video" || rNf.error !== "skipped_unowned" || panelCalls !== 0) {{
            throw new Error("Expected fast-fail before panel open: " + JSON.stringify({{ rVid, rNf, panelCalls }}));
          }}

          // 5. Missing Gemini API key -> skipped_cloud_error
          apiKey = "";
          const rNoKey = await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          if (rNoKey.error !== "skipped_cloud_error" || !String(rNoKey.errorDetail).includes("missing_gemini_api_key")) {{
            throw new Error("Expected missing_gemini_api_key detail: " + JSON.stringify(rNoKey));
          }}

          // 6. Listener cleanup on unexpected exception
          throwInPanel = true;
          let threw = false;
          try {{
            await window.WPhotoAiEngine.runAiDescription({{ photoId: "P_ERR", model: "cloud" }});
          }} catch (e) {{
            threw = e.message === "dom_crash";
          }}
          if (!threw || listenerDelta !== 0) {{
            throw new Error("Expected listeners cleaned up on throw, delta=" + listenerDelta);
          }}

          print("AI_05_OK");
        }})();
        """
        assert "AI_05_OK" in run_jsc(js)

    def ai_06():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        const timers = new Map();
        let tSeq = 0;
        let respondNano = false;
        globalThis.setTimeout = (fn, ms) => {{
          const id = ++tSeq;
          timers.set(id, fn);
          if (respondNano && ms >= 3000) return id;
          Promise.resolve().then(() => {{
            if (!timers.has(id)) return;
            timers.delete(id);
            fn();
          }});
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ timers.delete(id); }};
        globalThis.location = {{ origin: "https://photos.google.com", pathname: "/photo/NANO_1" }};

        let msgListeners = [];
        globalThis.addEventListener = (ev, fn) => {{ if (ev === "message") msgListeners.push(fn); }};
        globalThis.removeEventListener = (ev, fn) => {{ msgListeners = msgListeners.filter((f) => f !== fn); }};
        globalThis.postMessage = (data) => {{
          if (!respondNano || !data || data.ns !== "wphotoNano") return;
          Promise.resolve().then(() => {{
            const reply = data.op === "probe"
              ? {{ ns: "wphotoNanoReply", id: data.id, status: "available" }}
              : {{ ns: "wphotoNanoReply", id: data.id, text: "A photo of the Seine at twilight." }};
            for (const fn of [...msgListeners]) fn({{ source: globalThis.window, data: reply }});
          }});
        }};

        let injectCount = 0;
        let logStorage = "";
        let pendingLogGetCb = null;
        let holdLogGet = false;
        globalThis.chrome = {{
          runtime: {{
            sendMessage: (msg, cb) => {{
              if (msg.type === "BATCH_NANO_INJECT") injectCount++;
              cb && cb({{ ok: true }});
            }}
          }},
          storage: {{
            local: {{
              get: (k, cb) => {{
                if (holdLogGet && k === "aiDescriptionVerboseLog" && cb) {{
                  pendingLogGetCb = cb;
                  return null;
                }}
                const res = {{ aiDescriptionVerboseLog: logStorage }};
                if (cb) cb(res);
                return Promise.resolve(res);
              }},
              set: (obj, cb) => {{
                if ("aiDescriptionVerboseLog" in obj) logStorage = obj.aiDescriptionVerboseLog;
                if (cb) cb();
                return Promise.resolve();
              }}
            }}
          }}
        }};

        globalThis.document = {{
          querySelector: () => null,
          querySelectorAll: (s) => (s === "img" ? [{{ src: "https://lh3.googleusercontent.com/n", naturalWidth: 1000, naturalHeight: 800, offsetParent: {{}} }}] : [])
        }};

        let sentBodies = [];
        let fetchMode = "all_400";
        globalThis.fetch = async (url, init) => {{
          sentBodies.push(JSON.parse(init.body));
          if (fetchMode === "all_400") return {{ ok: false, status: 400, text: async () => "Bad API key" }};
          if (fetchMode === "400_then_200" && sentBodies.length === 1) return {{ ok: false, status: 400, text: async () => "Unknown field thinkingConfig" }};
          return {{ ok: true, status: 200, json: async () => ({{ candidates: [{{ content: {{ parts: [{{ text: "Canal in Venice." }}] }} }}] }}) }};
        }};

        load({prompts_file});
        load({dom_file});
        load({ai_file});

        let savedText = null;
        window.WPhotoDomCaption.ensureInfoPanelOpen = async () => ({{ ok: true }});
        window.WPhotoDomCaption.findVisibleDescriptionTextarea = () => ({{ value: "" }});
        window.WPhotoDomCaption.extractMetadataWithStabilization = async () => ({{ people: [], untaggedCount: 0, location: null, year: null }});
        window.WPhotoDomCaption.runCaption = async ({{ text }}) => {{
          savedText = text;
          return {{ success: true, timing: {{ textareaVisibleMs: 1, focusToInsertMs: 1, blurToSettleMs: 1, retried: false }} }};
        }};

        (async () => {{
          // 1. Both 400 (bad key) must NOT disable thinkingConfig on next valid call
          await window.WPhotoAiEngine.callGeminiCloud({{ apiKey: "BAD", instruction: "Describe." }});
          sentBodies = [];
          fetchMode = "400_then_200";
          const okAfterBadKey = await window.WPhotoAiEngine.callGeminiCloud({{ apiKey: "GOOD", instruction: "Describe." }});
          if (okAfterBadKey.error || sentBodies.length !== 2 || !sentBodies[0].generationConfig.thinkingConfig || sentBodies[1].generationConfig.thinkingConfig) {{
            throw new Error("Expected thinkingConfig kept after 400+400 and stripped on 400+200: " + JSON.stringify(sentBodies));
          }}
          // Next call skips thinkingConfig in 1 request
          sentBodies = [];
          fetchMode = "ok";
          await window.WPhotoAiEngine.callGeminiCloud({{ apiKey: "GOOD", instruction: "Describe." }});
          if (sentBodies.length !== 1 || sentBodies[0].generationConfig.thinkingConfig) {{
            throw new Error("Expected thinkingConfig to stay disabled after 400->200 fallback: " + JSON.stringify(sentBodies));
          }}

          // 2. Pre-aborted batch skips fetch
          sentBodies = [];
          globalThis.__wphotoIsBatchAborted = () => true;
          const rAborted = await window.WPhotoAiEngine.callGeminiCloud({{ apiKey: "GOOD", instruction: "Describe." }});
          if (rAborted.error !== "batch_aborted" || sentBodies.length !== 0) {{
            throw new Error("Expected batch_aborted without calling fetch: " + JSON.stringify(rAborted));
          }}
          globalThis.__wphotoIsBatchAborted = () => false;

          // 3. Local Nano success cleans caption and sets usedAi=true
          respondNano = true;
          const rNanoOk = await window.WPhotoAiEngine.runAiDescription({{ photoId: "NANO_1", model: "local", lang: "en" }});
          if (!rNanoOk.success || !rNanoOk.timing.usedAi || savedText !== "The Seine at twilight.") {{
            throw new Error("Expected Local Nano success with cleaned caption: " + JSON.stringify({{ rNanoOk, savedText }}));
          }}

          // 4. Local Nano timeout resets nanoInjectedOrigin (re-injects on next probe) and skips with no metadata
          respondNano = false;
          const beforeInjects = injectCount;
          const rNanoTimeout = await window.WPhotoAiEngine.runAiDescription({{ photoId: "NANO_1", model: "local", lang: "en" }});
          await window.WPhotoAiEngine.probeNanoAvailability();
          if (rNanoTimeout.success || rNanoTimeout.error !== "skipped_no_metadata" || injectCount <= beforeInjects) {{
            throw new Error("Expected Local Nano timeout to fall back to skipped_no_metadata and re-inject: " + JSON.stringify({{ rNanoTimeout, beforeInjects, injectCount }}));
          }}

          // 5. clearAiDescLog invalidates in-flight stale log flush
          holdLogGet = true;
          window.WPhotoAiEngine.appendAiDescLog("stale_line");
          holdLogGet = false;
          await window.WPhotoAiEngine.clearAiDescLog();
          pendingLogGetCb({{ aiDescriptionVerboseLog: "" }});
          if (logStorage !== "") {{
            throw new Error("Expected stale log flush after clearAiDescLog to be dropped, got: " + logStorage);
          }}

          print("AI_06_OK");
        }})();
        """
        assert "AI_06_OK" in run_jsc(js)

    runner.run_test(
        "AI-05",
        "Info panel failure propagation, unowned/video fast-fail, pre-hydration break, missing key & listener cleanup",
        ai_05,
    )
    runner.run_test(
        "AI-06",
        "Cloud 400 thinkingConfig fallback vs bad key, batch abort, Local Nano success/timeout & log clear race",
        ai_06,
    )

    # -------------------------------------------------------------------------
    # Suite 6: Batch Runner & Single-Menu UI (API Key Only Settings, No Icons)
    # -------------------------------------------------------------------------
    print("\n--- Suite 6: Batch Runner & Single-Menu UI ---")

    def ui_01():
        with open(os.path.join(ext_dir, "content/styles.css"), "r", encoding="utf-8") as f:
            css_text = f.read()
        assert "#3c4043" in css_text and "#e8eaed" in css_text and "#28292a" in css_text
        assert "Google Sans" in css_text

        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};
        globalThis.setInterval = () => 1;
        globalThis.clearInterval = () => {{}};
        globalThis.innerWidth = 1280;
        globalThis.innerHeight = 800;
        globalThis.addEventListener = () => {{}};
        globalThis.MutationObserver = class {{ observe() {{}} }};

        let bodyBgColor = "rgb(255, 255, 255)";
        globalThis.getComputedStyle = () => ({{ backgroundColor: bodyBgColor, overflowY: "visible" }});
        globalThis.location = {{ pathname: "/album/A1", href: "https://photos.google.com/album/A1" }};

        const storageData = {{}};
        const elementsById = {{}};

        function makeEl(tag) {{
          const el = {{
            tagName: tag.toUpperCase(),
            id: "",
            className: "",
            textContent: "",
            innerHTML: "",
            type: "",
            value: "",
            checked: false,
            disabled: false,
            style: {{}},
            attrs: {{}},
            children: [],
            listeners: {{}},
            parentElement: null,
            offsetParent: {{}},
            setAttribute(k, v) {{ this.attrs[k] = String(v); }},
            getAttribute(k) {{ return this.attrs[k] ?? null; }},
            removeAttribute(k) {{ delete this.attrs[k]; }},
            appendChild(child) {{
              child.parentElement = this;
              this.children.push(child);
              if (child.id) elementsById[child.id] = child;
              return child;
            }},
            insertBefore(child) {{
              return this.appendChild(child);
            }},
            remove() {{
              if (this.id) delete elementsById[this.id];
            }},
            addEventListener(ev, fn) {{
              this.listeners[ev] = fn;
            }},
            click() {{
              if (this.listeners.click) this.listeners.click({{ stopPropagation: () => {{}} }});
            }},
            getBoundingClientRect() {{
              const pLeft = this.parentElement && this.parentElement !== bodyEl && this.parentElement.getBoundingClientRect
                ? this.parentElement.getBoundingClientRect().left
                : 200;
              return {{ left: pLeft, top: 20, right: pLeft + 100, bottom: 56, width: 100, height: 36 }};
            }},
            querySelectorAll(sel) {{
              let out = [];
              const walk = (node) => {{
                for (const c of node.children || []) {{
                  if (sel === "svg" && c.tagName === "SVG") out.push(c);
                  if (sel === "button" && c.tagName === "BUTTON") out.push(c);
                  if (sel === ".wphoto-title" && c.className === "wphoto-title") out.push(c);
                  walk(c);
                }}
              }};
              walk(this);
              return out;
            }}
          }};
          return el;
        }}

        const bodyEl = makeEl("body");
        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async (keys) => {{
                if (typeof keys === "string") return {{ [keys]: storageData[keys] }};
                if (Array.isArray(keys)) {{
                  const out = {{}};
                  for (const k of keys) out[k] = storageData[k];
                  return out;
                }}
                return {{ ...storageData }};
              }},
              set: async (obj) => {{ Object.assign(storageData, obj); }},
              remove: async (key) => {{ delete storageData[key]; }}
            }},
            onChanged: {{ addListener: () => {{}} }}
          }},
          runtime: {{
            onMessage: {{ addListener: () => {{}} }},
            sendMessage: (msg, cb) => cb && cb({{ ok: true }})
          }}
        }};

        globalThis.document = {{
          readyState: "complete",
          documentElement: null,
          body: bodyEl,
          createElement: (tag) => makeEl(tag),
          getElementById: (id) => elementsById[id] || null,
          querySelector: () => null,
          querySelectorAll: () => [],
          addEventListener: () => {{}}
        }};

        load({prompts_file});
        load({sel_file});
        load({dom_file});
        load({ai_file});
        load({runner_file});
        load({ui_file});

        (async () => {{
          await window.WPhotoDomCaption.sleep(10);
          const trigger = elementsById["wphoto-trigger-btn"];
          if (!trigger || trigger.textContent !== "AI Plus" || trigger.getAttribute("aria-label") !== "AI Plus") {{
            throw new Error("Trigger button not mounted with text 'AI Plus'");
          }}
          if (trigger.getAttribute("data-theme") !== "light") {{
            throw new Error("Expected light theme on white Google Photos background");
          }}

          // Switch Google Photos background to dark mode and open menu
          bodyBgColor = "rgb(32, 33, 36)";
          trigger.click();
          const card = elementsById["wphoto-menu-card"];
          if (!card || card.getAttribute("aria-label") !== "AI Plus Menu") {{
            throw new Error("Menu card did not open with 'AI Plus Menu' aria-label");
          }}
          if (card.getAttribute("data-theme") !== "dark") {{
            throw new Error("Expected dark theme on dark Google Photos background");
          }}
          const titles = card.querySelectorAll(".wphoto-title");
          if (titles.length !== 1 || titles[0].textContent !== "AI Plus") {{
            throw new Error("Expected menu header title to be 'AI Plus'");
          }}

          // Verify zero SVG icons inside menu card
          if (card.querySelectorAll("svg").length !== 0) {{
            throw new Error("Menu card must not contain any SVG icons");
          }}

          // Verify language buttons match WPHOTO_PROMPTS (English, Français, Español)
          const buttons = card.querySelectorAll("button").map((b) => b.textContent);
          for (const expectedBtn of ["API Key", "English", "Français", "Español", "Cloud", "Local", "No", "Yes", "Describe album photos"]) {{
            if (!buttons.includes(expectedBtn)) {{
              throw new Error("Missing expected button '" + expectedBtn + "' in: " + JSON.stringify(buttons));
            }}
          }}

          // Switch language to French ("Français") and verify all menu buttons & API Key view translate
          const frBtn = card.querySelectorAll("button").find((b) => b.textContent === "Français");
          frBtn.click();
          const frButtons = card.querySelectorAll("button").map((b) => b.textContent);
          for (const expectedFr of ["Clé API", "Non", "Oui", "Configurer la clé API", "Décrire les photos de l'album"]) {{
            if (!frButtons.includes(expectedFr)) {{
              throw new Error("Missing French button '" + expectedFr + "' in: " + JSON.stringify(frButtons));
            }}
          }}
          if (card.getAttribute("aria-label") !== "Menu AI Plus") {{
            throw new Error("Expected French menu aria-label 'Menu AI Plus'");
          }}

          // Switch to API Key view and verify Show/Hide keeps unsaved draft without mutating state.apiKey
          card.querySelectorAll("button").find((b) => b.textContent === "Clé API").click();
          const keyInput = card.children.flatMap((c) => c.children || []).find((n) => n.tagName === "INPUT");
          keyInput.value = "UNSAVED_DRAFT";
          card.querySelectorAll("button").find((b) => b.textContent === "Afficher").click();
          if (keyInput.type !== "text" || keyInput.value !== "UNSAVED_DRAFT" || window.WPhotoUi.state.apiKey !== "") {{
            throw new Error("Show/Hide mutated state.apiKey or lost draft input");
          }}
          card.querySelectorAll("button").find((b) => b.textContent === "Masquer").click();
          if (keyInput.type !== "password") throw new Error("Hide did not restore password input type");
          const frApiButtons = card.querySelectorAll("button").map((b) => b.textContent);
          for (const expectedFrApi of ["Retour", "Afficher", "Enregistrer", "Effacer"]) {{
            if (!frApiButtons.includes(expectedFrApi)) {{
              throw new Error("Missing French API view button '" + expectedFrApi + "' in: " + JSON.stringify(frApiButtons));
            }}
          }}
          // Return to main view and test Spanish ("Español")
          card.querySelectorAll("button").find((b) => b.textContent === "Retour").click();
          card.querySelectorAll("button").find((b) => b.textContent === "Español").click();
          const esButtons = card.querySelectorAll("button").map((b) => b.textContent);
          for (const expectedEs of ["Clave API", "Nube", "Local", "No", "Sí", "Configurar clave API", "Describir fotos del álbum"]) {{
            if (!esButtons.includes(expectedEs)) {{
              throw new Error("Missing Spanish button '" + expectedEs + "' in: " + JSON.stringify(esButtons));
            }}
          }}
          // Switch back to English
          card.querySelectorAll("button").find((b) => b.textContent === "English").click();

          // Test API Key Settings save & clear
          await window.WPhotoUi.saveGeminiApiKey("  AIzaSyTestKey987654321  ");
          if (storageData.geminiApiKey !== "AIzaSyTestKey987654321") {{
            throw new Error("API key was not trimmed and saved to local storage");
          }}
          if (window.WPhotoUi.maskApiKey(storageData.geminiApiKey) !== "AIza••••••••4321") {{
            throw new Error("API key mask failed");
          }}
          await window.WPhotoUi.clearGeminiApiKey();
          if (storageData.geminiApiKey !== undefined) {{
            throw new Error("API key was not cleared from storage");
          }}

          // Navigate to a single photo (/photo/P1 and /album/A1/photo/P1) -> menu and trigger button must be hidden/removed
          for (const singlePhotoPath of ["/photo/P1", "/album/A1/photo/P1", "/u/0/album/A1/photo/P1"]) {{
            globalThis.location.pathname = singlePhotoPath;
            globalThis.location.href = "https://photos.google.com" + singlePhotoPath;
            window.WPhotoUi.ensureTriggerButtonMounted();
            if (elementsById["wphoto-trigger-btn"] || elementsById["wphoto-menu-card"] || window.WPhotoUi.state.menuOpen) {{
              throw new Error("Expected menu and trigger button to be hidden when viewing a single photo at " + singlePhotoPath);
            }}
          }}

          // Navigate to Google Photos home page (/ and /u/0/) with no selection -> menu and trigger button must be hidden
          for (const homePath of ["/", "/u/0/", "/albums"]) {{
            globalThis.location.pathname = homePath;
            globalThis.location.href = "https://photos.google.com" + homePath;
            window.WPhotoUi.ensureTriggerButtonMounted();
            if (elementsById["wphoto-trigger-btn"] || elementsById["wphoto-menu-card"] || window.WPhotoUi.state.menuOpen) {{
              throw new Error("Expected menu and trigger button to be hidden on home page with no selection at " + homePath);
            }}
          }}

          // Test top-bar action cluster placement when returning to /album/A1
          globalThis.location.pathname = "/album/A1";
          globalThis.location.href = "https://photos.google.com/album/A1";
          const topBarCluster = makeEl("div");
          topBarCluster.getBoundingClientRect = () => ({{ left: 850, top: 8, width: 320, height: 48 }});
          topBarCluster.contains = (node) => topBarCluster.children.includes(node);
          const createIconBtn = makeEl("button");
          createIconBtn.setAttribute("aria-label", "Create");
          createIconBtn.getBoundingClientRect = () => ({{ left: 920, top: 12, width: 40, height: 40 }});
          createIconBtn.closest = () => null;
          topBarCluster.appendChild(createIconBtn);

          globalThis.document.querySelectorAll = (sel) => {{
            if (sel.includes('a[aria-label]')) return [createIconBtn];
            return [];
          }};
          window.WPhotoUi.ensureTriggerButtonMounted();
          const remounted = elementsById["wphoto-trigger-btn"];
          if (!remounted || remounted.parentElement !== topBarCluster || remounted.getAttribute("data-pinned") !== null || remounted.getAttribute("data-placement") !== "home") {{
            throw new Error("Expected trigger button to mount inside top-bar right action cluster before Create button");
          }}

          // Test bottom-right status bar auto-dismisses when batch process is done
          window.WPhotoUi.state.activeBatch = {{
            photoIds: ["P1", "P2"],
            completedIds: ["P1", "P2"],
            skippedIds: [],
            failedIds: [],
            completedAt: Date.now(),
            lastReason: null,
            options: {{ lang: "en" }}
          }};
          storageData.activeBatch = window.WPhotoUi.state.activeBatch;
          window.WPhotoUi.renderStatusBar();
          await window.WPhotoDomCaption.sleep(10);
          if (elementsById["wphoto-status-bar"] || storageData.activeBatch) {{
            throw new Error("Expected bottom-right status bar to auto-dismiss and clear activeBatch after completion");
          }}

          print("UI_01_OK");
        }})();
        """
        assert "UI_01_OK" in run_jsc(js)

    def run_01():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};
        globalThis.addEventListener = () => {{}};

        let currentPath = "/photo/P1";
        let reloaded = false;
        const storageData = {{}};

        globalThis.location = {{
          get pathname() {{ return currentPath; }},
          get href() {{ return "https://photos.google.com" + currentPath; }},
          set href(val) {{
            const m = val.match(/https:\\/\\/photos\\.google\\.com(\\/.*)$/);
            currentPath = m ? m[1] : val;
          }},
          reload() {{ reloaded = true; }}
        }};

        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async (k) => (typeof k === "string" ? {{ [k]: storageData[k] }} : ({{ ...storageData }})),
              set: async (obj) => {{ Object.assign(storageData, obj); }},
              remove: async (k) => {{ delete storageData[k]; }}
            }},
            onChanged: {{ addListener: () => {{}} }}
          }},
          runtime: {{
            onMessage: {{ addListener: () => {{}} }},
            sendMessage: (msg, cb) => cb && cb({{ ok: true }})
          }}
        }};

        globalThis.document = {{ documentElement: null }};

        load({prompts_file});
        load({sel_file});
        load({dom_file});
        load({ai_file});
        load({runner_file});

        let attemptCount = 0;
        let receivedPrefilled = {{}};
        window.WPhotoAiEngine.runAiDescription = async ({{ photoId, prefilledCaption }}) => {{
          attemptCount++;
          receivedPrefilled[photoId] = prefilledCaption || null;
          if (photoId === "P1" && attemptCount === 1) {{
            return {{ success: false, error: "textarea_not_visible", timing: {{}} }};
          }}
          if (photoId === "P1") {{
            // Simulate a stack where P1 succeeded and P1_STACK_2 is pending fallback navigation with sharedCaption
            return {{
              success: true,
              errorDetail: JSON.stringify({{
                extraCompletedIds: [],
                pendingStackIds: ["P1_STACK_2"],
                captionedIds: ["P1"],
                sharedCaption: "Shared stack caption."
              }}),
              timing: {{}}
            }};
          }}
          return {{ success: true, timing: {{}} }};
        }};

        (async () => {{
          // Kick off batch on P1 and P2; P1 fails with textarea_not_visible on attempt 1 -> triggers 1x reload retry
          await window.WPhotoBatchRunner.kickOffBatch({{
            photoIds: ["P1", "P2"],
            originUrl: "https://photos.google.com/album/A1",
            options: {{ lang: "fr", model: "cloud", overwrite: true }}
          }});

          if (!reloaded || storageData.activeBatch.retryPhotoIds["P1"] !== 1) {{
            throw new Error("Expected 1x reload retry on transient textarea_not_visible");
          }}

          // Continue batch after reload -> P1 succeeds, does NOT falsely mark P1_STACK_2 completed yet, and navigates to P1_STACK_2 next
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (currentPath !== "/photo/P1_STACK_2" || storageData.activeBatch.completedIds.length !== 1 || !storageData.activeBatch.completedIds.includes("P1")) {{
            throw new Error("Expected only P1 in completedIds and transition to /photo/P1_STACK_2, got: " + JSON.stringify({{ currentPath, completedIds: storageData.activeBatch.completedIds }}));
          }}

          // Continue on P1_STACK_2 -> receives prefilledCaption="Shared stack caption." without calling model again, then transitions to /photo/P2
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (receivedPrefilled["P1_STACK_2"] !== "Shared stack caption." || currentPath !== "/photo/P2") {{
            throw new Error("Expected P1_STACK_2 to receive prefilledCaption and transition to /photo/P2, got: " + JSON.stringify({{ receivedPrefilled, currentPath }}));
          }}

          // Pause & Resume
          await window.WPhotoBatchRunner.pauseBatch();
          if (storageData.activeBatch.lastReason !== "paused") {{
            throw new Error("Expected batch to pause");
          }}
          await window.WPhotoBatchRunner.resumeBatch();
          if (storageData.activeBatch.completedIds.length !== 3 || storageData.activeBatch.completedAt === null) {{
            throw new Error("Expected P1, P1_STACK_2, and P2 to complete after resume: " + JSON.stringify(storageData.activeBatch));
          }}
          if (currentPath !== "/album/A1") {{
            throw new Error("Expected return to originUrl /album/A1 after completion, got: " + currentPath);
          }}

          // Out-of-order stack completion (A completes C) advances to B, and rejected step records failure instead of hanging
          delete storageData.activeBatch;
          currentPath = "/photo/A";
          window.WPhotoAiEngine.runAiDescription = async ({{ photoId }}) => {{
            if (photoId === "A") {{
              return {{
                success: true,
                errorDetail: JSON.stringify({{ extraCompletedIds: ["C"], captionedIds: ["A", "C"] }}),
                timing: {{}}
              }};
            }}
            if (photoId === "B") throw new Error("boom");
            return {{ success: true, timing: {{}} }};
          }};
          await window.WPhotoBatchRunner.kickOffBatch({{
            photoIds: ["A", "B", "C"],
            originUrl: "https://photos.google.com/album/A1"
          }});
          if (currentPath !== "/photo/B") {{
            throw new Error("Expected out-of-order stack completion to target B next, got: " + currentPath);
          }}
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (!storageData.activeBatch.failedIds.includes("B") || storageData.activeBatch.failureReasons["B"] !== "unexpected_error" || currentPath !== "/album/A1") {{
            throw new Error("Expected rejected step B to fail cleanly and finish batch: " + JSON.stringify({{ currentPath, batch: storageData.activeBatch }}));
          }}

          print("RUN_01_OK");
        }})();
        """
        assert "RUN_01_OK" in run_jsc(js)

    def ui_02():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        const timers = new Map();
        let tSeq = 0;
        let autoFireShort = true;
        globalThis.setTimeout = (fn, ms) => {{
          const id = ++tSeq;
          timers.set(id, fn);
          if (autoFireShort && ms < 2000) {{
            Promise.resolve().then(() => {{
              if (!timers.has(id)) return;
              timers.delete(id);
              fn();
            }});
          }}
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ timers.delete(id); }};
        globalThis.setInterval = () => 1;
        globalThis.clearInterval = () => {{}};
        globalThis.innerWidth = 1280;
        globalThis.innerHeight = 800;
        globalThis.addEventListener = () => {{}};
        globalThis.MutationObserver = class {{ observe() {{}} }};
        globalThis.getComputedStyle = () => ({{ backgroundColor: "rgb(255, 255, 255)", overflowY: "visible" }});
        globalThis.location = {{ pathname: "/album/A1", href: "https://photos.google.com/album/A1" }};

        const storageData = {{}};
        const elementsById = {{}};
        function makeEl(tag) {{
          return {{
            tagName: tag.toUpperCase(),
            id: "",
            className: "",
            textContent: "",
            innerHTML: "",
            type: "",
            value: "",
            checked: false,
            disabled: false,
            style: {{}},
            attrs: {{}},
            children: [],
            listeners: {{}},
            parentElement: null,
            offsetParent: {{}},
            firstChild: null,
            previousElementSibling: null,
            nextElementSibling: null,
            setAttribute(k, v) {{ this.attrs[k] = String(v); }},
            getAttribute(k) {{ return k in this.attrs ? this.attrs[k] : null; }},
            removeAttribute(k) {{ delete this.attrs[k]; }},
            contains(t) {{ return this === t || this.children.some((c) => c.contains(t)); }},
            appendChild(c) {{ c.parentElement = this; this.children.push(c); this.firstChild = this.children[0]; if (c.id) elementsById[c.id] = c; return c; }},
            insertBefore(c) {{ return this.appendChild(c); }},
            remove() {{ if (this.id) delete elementsById[this.id]; this.parentElement = null; }},
            addEventListener(ev, fn) {{ this.listeners[ev] = fn; }},
            click() {{ if (this.listeners.click) this.listeners.click({{ stopPropagation: () => {{}} }}); }},
            getBoundingClientRect() {{ return {{ left: 900, top: 20, right: 1000, bottom: 56, width: 100, height: 36 }}; }},
            querySelector: () => null,
            querySelectorAll(sel) {{
              const out = [];
              const walk = (n) => {{
                for (const c of n.children || []) {{
                  if (sel === "button" && c.tagName === "BUTTON") out.push(c);
                  walk(c);
                }}
              }};
              walk(this);
              return out;
            }}
          }};
        }}

        const bodyEl = makeEl("body");
        let clearBtnMock = null;
        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async (keys) => {{
                if (typeof keys === "string") return {{ [keys]: storageData[keys] }};
                const out = {{}};
                for (const k of keys || []) out[k] = storageData[k];
                return out;
              }},
              set: async (obj) => {{ Object.assign(storageData, obj); }},
              remove: async (k) => {{ delete storageData[k]; }}
            }},
            onChanged: {{ addListener: () => {{}} }}
          }},
          runtime: {{ onMessage: {{ addListener: () => {{}} }}, sendMessage: (m, cb) => cb && cb({{ ok: true }}) }}
        }};
        globalThis.document = {{
          readyState: "complete",
          documentElement: null,
          body: bodyEl,
          createElement: (t) => makeEl(t),
          getElementById: (id) => elementsById[id] || null,
          querySelector: (sel) => (sel.includes("Clear selection") ? clearBtnMock : null),
          querySelectorAll: () => [],
          addEventListener: () => {{}}
        }};

        load({prompts_file});
        load({sel_file});
        load({dom_file});
        load({ai_file});
        load({runner_file});
        load({ui_file});

        (async () => {{
          await window.WPhotoDomCaption.sleep(10);

          // 1. Pinned body fallback when no selection bar, anchor, or flex bar
          const trig = elementsById["wphoto-trigger-btn"];
          if (!trig || trig.getAttribute("data-pinned") !== "true" || trig.parentElement !== bodyEl) {{
            throw new Error("Expected pinned body fallback when no header anchor found");
          }}

          // 2. Selection bar mounting
          const selContainer = makeEl("div");
          const shareCluster = makeEl("div");
          const shareBtn = makeEl("button");
          const clearBtn = makeEl("button");
          shareCluster.appendChild(shareBtn);
          selContainer.appendChild(shareCluster);
          selContainer.appendChild(clearBtn);
          selContainer.querySelector = (s) => (s.includes("Share") ? shareBtn : null);
          clearBtnMock = clearBtn;
          window.WPhotoUi.ensureTriggerButtonMounted();
          if (trig.getAttribute("data-placement") !== "selection" || trig.getAttribute("data-pinned") !== null || trig.parentElement !== shareCluster) {{
            throw new Error("Expected trigger button to mount inside selection container");
          }}
          clearBtnMock = null;

          // 3. Missing API key redirects CTA click to apikey view
          trig.click();
          let card = elementsById["wphoto-menu-card"];
          const cta1 = card.querySelectorAll("button").find((b) => b.getAttribute("data-wphoto-primary-cta") === "true");
          cta1.click();
          if (window.WPhotoUi.state.view !== "apikey") {{
            throw new Error("Expected CTA with missing cloud key to switch to apikey view");
          }}

          // 4. enumerateCurrentAlbum rejection resets enumeratingAlbum=false and re-enables CTA
          await window.WPhotoUi.saveGeminiApiKey("AIzaSyValidKey");
          card.querySelectorAll("button").find((b) => b.textContent === "Back").click();
          window.WPhotoSelection.enumerateCurrentAlbum = async () => {{ throw new Error("rpc_down"); }};
          const cta2 = card.querySelectorAll("button").find((b) => b.getAttribute("data-wphoto-primary-cta") === "true");
          await cta2.listeners.click({{ stopPropagation: () => {{}} }}).catch(() => {{}});
          const ctaAfter = card.querySelectorAll("button").find((b) => b.getAttribute("data-wphoto-primary-cta") === "true");
          if (window.WPhotoUi.state.enumeratingAlbum !== false || ctaAfter.disabled) {{
            throw new Error("Expected enumeratingAlbum reset after RPC rejection");
          }}

          // 5. Async local probe resolving after closeMenu() updates state without reopening card
          let resolveProbe;
          window.WPhotoAiEngine.probeNanoAvailability = () => new Promise((r) => {{ resolveProbe = r; }});
          card.querySelectorAll("button").find((b) => b.textContent === "Local").click();
          window.WPhotoUi.closeMenu();
          resolveProbe("available");
          await window.WPhotoDomCaption.sleep(10);
          if (window.WPhotoUi.state.nanoStatus !== "available" || elementsById["wphoto-menu-card"]) {{
            throw new Error("Closed-menu probe reopened card or failed to update nanoStatus");
          }}

          // 6. Status bar running, paused (no auto-dismiss), and cancelled (auto-dismiss)
          autoFireShort = false;
          window.WPhotoUi.state.activeBatch = {{ photoIds: ["P1", "P2"], completedIds: ["P1"], skippedIds: [], failedIds: [], completedAt: null, lastReason: null, options: {{ lang: "en" }} }};
          window.WPhotoUi.renderStatusBar();
          const runBtns = elementsById["wphoto-status-bar"].querySelectorAll("button").map((b) => b.textContent);
          if (!runBtns.includes("Pause") || !runBtns.includes("Cancel")) throw new Error("Running status bar missing Pause/Cancel");

          const timersBeforePause = timers.size;
          window.WPhotoUi.state.activeBatch = {{ photoIds: ["P1", "P2"], completedIds: ["P1"], skippedIds: [], failedIds: [], completedAt: Date.now(), lastReason: "paused", options: {{ lang: "en" }} }};
          window.WPhotoUi.renderStatusBar();
          const pauseBtns = elementsById["wphoto-status-bar"].querySelectorAll("button").map((b) => b.textContent);
          if (!pauseBtns.includes("Resume") || timers.size !== timersBeforePause) throw new Error("Paused status bar invalid or scheduled auto-dismiss");

          window.WPhotoUi.state.activeBatch = {{ photoIds: ["P1", "P2"], completedIds: [], skippedIds: [], failedIds: [], completedAt: Date.now(), lastReason: "cancelled", options: {{ lang: "en" }} }};
          window.WPhotoUi.renderStatusBar();
          for (const [id, fn] of [...timers]) {{ timers.delete(id); fn(); }}
          if (elementsById["wphoto-status-bar"]) throw new Error("Expected cancelled status bar to auto-dismiss");

          print("UI_02_OK");
        }})();
        """
        assert "UI_02_OK" in run_jsc(js)

    def run_02():
        js = f"""
        globalThis.window = globalThis;
        globalThis.performance = {{ now: () => Date.now() }};
        const timers = new Map();
        let tSeq = 0;
        globalThis.setTimeout = (fn) => {{
          const id = ++tSeq;
          timers.set(id, fn);
          Promise.resolve().then(() => {{
            if (!timers.has(id)) return;
            timers.delete(id);
            fn();
          }});
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ timers.delete(id); }};
        globalThis.addEventListener = () => {{}};

        let currentPath = "/photo/P_TO";
        let reloaded = false;
        let attachResp = {{ ok: true }};
        let detachCount = 0;
        let unexpectedDetachCb = null;
        const storageData = {{}};
        globalThis.location = {{
          get pathname() {{ return currentPath; }},
          get href() {{ return "https://photos.google.com" + currentPath; }},
          set href(v) {{ const m = v.match(/https:\\/\\/photos\\.google\\.com(\\/.*)$/); currentPath = m ? m[1] : v; }},
          reload() {{ reloaded = true; }}
        }};
        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async (k) => (typeof k === "string" ? {{ [k]: storageData[k] }} : ({{ ...storageData }})),
              set: async (o) => {{ Object.assign(storageData, o); }},
              remove: async (k) => {{ delete storageData[k]; }}
            }},
            onChanged: {{ addListener: () => {{}} }}
          }},
          runtime: {{
            onMessage: {{ addListener: (fn) => {{ unexpectedDetachCb = fn; }} }},
            sendMessage: (msg, cb) => {{
              if (msg.type === "BATCH_ATTACH") return cb && cb(attachResp);
              if (msg.type === "BATCH_DETACH") detachCount++;
              cb && cb({{ ok: true }});
            }}
          }}
        }};
        globalThis.document = {{ documentElement: null }};

        load({prompts_file});
        load({sel_file});
        load({dom_file});
        load({ai_file});
        load({runner_file});

        (async () => {{
          // 1. Wall-clock timeout aborts active controller, records photo_timeout, and advances
          let ctrlAborted = false;
          window.WPhotoAiEngine.runAiDescription = async ({{ photoId }}) => {{
            if (photoId === "P_TO") {{
              window.__wphotoActiveAbortController = {{ abort() {{ ctrlAborted = true; }} }};
              return new Promise(() => {{}});
            }}
            if (photoId === "P_PANEL") return {{ success: false, error: "info_panel_did_not_open", timing: {{}} }};
            if (photoId === "P_VID") return {{ success: false, error: "skipped_video", timing: {{}} }};
            if (photoId === "P_UNOWNED") return {{ success: false, error: "skipped_unowned", timing: {{}} }};
            return {{ success: true, timing: {{}} }};
          }};
          await window.WPhotoBatchRunner.kickOffBatch({{
            photoIds: ["P_TO", "P_PANEL", "P_VID", "P_UNOWNED"],
            originUrl: "https://photos.google.com/album/A1"
          }});
          if (!ctrlAborted || storageData.activeBatch.failureReasons["P_TO"] !== "photo_timeout" || currentPath !== "/photo/P_PANEL") {{
            throw new Error("Expected wall-clock timeout recovery to P_PANEL: " + JSON.stringify({{ ctrlAborted, currentPath, batch: storageData.activeBatch }}));
          }}

          // 2. info_panel_did_not_open retries once via reload, then fails on attempt 2 and advances
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (!reloaded || storageData.activeBatch.retryPhotoIds["P_PANEL"] !== 1 || currentPath !== "/photo/P_PANEL") {{
            throw new Error("Expected 1x reload retry on info_panel_did_not_open");
          }}
          reloaded = false;
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (reloaded || !storageData.activeBatch.failedIds.includes("P_PANEL") || storageData.activeBatch.failureReasons["P_PANEL"] !== "info_panel_did_not_open" || currentPath !== "/photo/P_VID") {{
            throw new Error("Expected info_panel_did_not_open retry exhaustion to fail and advance to P_VID");
          }}

          // 3. Skip codes advance without failure and finish to origin
          await window.WPhotoBatchRunner.continueBatchIfActive();
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (storageData.activeBatch.skippedIds.length !== 2 || storageData.activeBatch.failedIds.length !== 2 || currentPath !== "/album/A1") {{
            throw new Error("Expected skipped_video & skipped_unowned to finish batch cleanly: " + JSON.stringify({{ currentPath, batch: storageData.activeBatch }}));
          }}

          // 4. BATCH_ATTACH failure on kickOff and detached_by_user during step
          attachResp = {{ ok: false, error: "attach_denied" }};
          const koFail = await window.WPhotoBatchRunner.kickOffBatch({{ photoIds: ["X1"], originUrl: "https://photos.google.com/album/A1" }});
          if (koFail.started || storageData.activeBatch.lastReason !== "dom_abort") {{
            throw new Error("Expected dom_abort on kickOff attach failure");
          }}

          attachResp = {{ ok: true }};
          currentPath = "/photo/X1";
          window.WPhotoAiEngine.runAiDescription = async () => {{
            attachResp = {{ ok: false, error: "detached_by_user" }};
            return {{ success: true, timing: {{}} }};
          }};
          const prevDetach = detachCount;
          await window.WPhotoBatchRunner.kickOffBatch({{ photoIds: ["X1", "X2"], originUrl: "https://photos.google.com/album/A1" }});
          // Now simulate step attach returning detached_by_user on X2
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (storageData.activeBatch.lastReason !== "cancelled" || detachCount <= prevDetach) {{
            throw new Error("Expected detached_by_user to cancel batch and detach");
          }}

          // 5. cancelBatch and BATCH_UNEXPECTED_DETACH behavior (active vs completed)
          attachResp = {{ ok: true }};
          currentPath = "/photo/C1";
          let holdResolve;
          let resolveEntered;
          const pEntered = new Promise((r) => {{ resolveEntered = r; }});
          window.WPhotoAiEngine.runAiDescription = () => {{
            resolveEntered();
            return new Promise((r) => {{ holdResolve = r; }});
          }};
          const pRun = window.WPhotoBatchRunner.kickOffBatch({{ photoIds: ["C1", "C2"], originUrl: "https://photos.google.com/album/A1" }});
          await pEntered;
          await window.WPhotoBatchRunner.cancelBatch();
          holdResolve({{ success: false, error: "batch_aborted" }});
          await pRun;
          if (storageData.activeBatch.lastReason !== "cancelled") throw new Error("cancelBatch failed");

          // Unexpected detach preserves finished batch
          storageData.activeBatch = {{ photoIds: ["Z1"], completedIds: ["Z1"], failedIds: [], skippedIds: [], completedAt: 999, lastReason: null }};
          unexpectedDetachCb({{ type: "BATCH_UNEXPECTED_DETACH" }});
          await window.WPhotoDomCaption.sleep(5);
          if (storageData.activeBatch.lastReason !== null) throw new Error("BATCH_UNEXPECTED_DETACH overwrote finished batch");

          // 6. photoIdStillPending Top-Pick redirect fallback schedules P1 before P2
          delete storageData.activeBatch;
          currentPath = "/photo/P1";
          window.WPhotoAiEngine.runAiDescription = async ({{ photoId }}) => ({{
            success: true,
            errorDetail: photoId === "P1" ? JSON.stringify({{ pendingStackIds: ["P1"], captionedIds: ["T1"], sharedCaption: "Stack shared." }}) : undefined,
            timing: {{}}
          }});
          await window.WPhotoBatchRunner.kickOffBatch({{ photoIds: ["P1", "P2"], originUrl: "https://photos.google.com/album/A1" }});
          if (currentPath !== "/photo/P1" || storageData.activeBatch.prefilledCaptions["P1"] !== "Stack shared." || !storageData.activeBatch.completedIds.includes("T1")) {{
            throw new Error("Expected photoIdStillPending fallback to schedule P1 with prefilledCaption: " + JSON.stringify({{ currentPath, batch: storageData.activeBatch }}));
          }}

          print("RUN_02_OK");
        }})();
        """
        assert "RUN_02_OK" in run_jsc(js)

    runner.run_test(
        "UI-01",
        "Single menu renders EN/FR/ES, Cloud/Local, Overwrite No/Yes, API Key-only settings, and zero icons",
        ui_01,
    )
    runner.run_test(
        "UI-02",
        "Selection bar mounting, pinned fallback, missing-key redirect, album RPC error recovery & status bar states",
        ui_02,
    )
    runner.run_test(
        "RUN-01",
        "Batch state machine handles kickOff, 1x transient reload retry, pause/resume, and return to origin",
        run_01,
    )
    runner.run_test(
        "RUN-02",
        "Batch runner wall-clock timeout, info-panel retry exhaustion, skip codes, attach abort & stack fallback",
        run_02,
    )

    bg_file = json.dumps(os.path.join(ext_dir, "background/background.js"))

    def bg_01():
        js = f"""
        globalThis.setTimeout = (fn) => {{ Promise.resolve().then(fn); return 1; }};
        globalThis.clearTimeout = () => {{}};

        let onMessageHandler = null;
        let onEventHandler = null;
        let onDetachHandler = null;
        let cdpSent = [];
        let tabMessages = [];

        globalThis.chrome = {{
          runtime: {{
            lastError: null,
            onMessage: {{
              addListener(fn) {{ onMessageHandler = fn; }}
            }}
          }},
          tabs: {{
            sendMessage(tabId, msg) {{
              tabMessages.push({{ tabId, msg }});
              return Promise.resolve();
            }}
          }},
          scripting: {{
            executeScript: async () => [{{}}]
          }},
          debugger: {{
            onEvent: {{
              addListener(fn) {{ onEventHandler = fn; }}
            }},
            onDetach: {{
              addListener(fn) {{ onDetachHandler = fn; }}
            }},
            attach(target, ver, cb) {{ cb(); }},
            detach(target, cb) {{ cb(); }},
            sendCommand(target, method, params, cb) {{
              cdpSent.push({{ tabId: target.tabId, method, params }});
              cb({{}});
            }}
          }}
        }};

        load({bg_file});

        function sendMsg(msg, tabId = 42) {{
          return new Promise((resolve) => {{
            onMessageHandler(msg, {{ tab: {{ id: tabId }} }}, resolve);
          }});
        }}

        (async () => {{
          const rAttach = await sendMsg({{ type: "BATCH_ATTACH" }});
          if (!rAttach.ok || !rAttach.attached) throw new Error("BATCH_ATTACH failed");

          const rClick = await sendMsg({{ type: "BATCH_DISPATCH_CLICK_AT", x: 120, y: 340 }});
          if (!rClick.ok) throw new Error("BATCH_DISPATCH_CLICK_AT failed");

          const rInsert = await sendMsg({{ type: "BATCH_INSERT_TEXT", text: "Hello World" }});
          if (!rInsert.ok) throw new Error("BATCH_INSERT_TEXT failed");

          // Simulate batchexecute network request & finish before save quiescence
          onEventHandler({{ tabId: 42 }}, "Network.requestWillBeSent", {{
            requestId: "req1",
            request: {{ url: "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=save" }}
          }});
          onEventHandler({{ tabId: 42 }}, "Network.loadingFinished", {{ requestId: "req1" }});

          const rQuiesce = await sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 10, maxWaitMs: 500, seedRecentMs: 1000 }});
          if (!rQuiesce.ok || rQuiesce.saveXhrsObserved < 1) {{
            throw new Error("BATCH_AWAIT_SAVE_QUIESCENCE failed: " + JSON.stringify(rQuiesce));
          }}

          // Unexpected detach notification ("AI Plus is debugging this browser" -> Cancel)
          onDetachHandler({{ tabId: 42 }}, "canceled_by_user");
          if (tabMessages.length === 0 || tabMessages[0].msg.type !== "BATCH_UNEXPECTED_DETACH") {{
            throw new Error("Expected BATCH_UNEXPECTED_DETACH message on debugger detach");
          }}

          // Automatic/step re-attach must be refused after user clicked Cancel on debugger banner
          const rAutoReattach = await sendMsg({{ type: "BATCH_ATTACH", forPhotoStep: true }});
          if (rAutoReattach.ok || rAutoReattach.error !== "detached_by_user") {{
            throw new Error("Expected automatic BATCH_ATTACH to be blocked after user detach, got: " + JSON.stringify(rAutoReattach));
          }}

          // Explicit user start from UI clears detached state and attaches cleanly
          const rExplicitReattach = await sendMsg({{ type: "BATCH_ATTACH", explicitStart: true }});
          if (!rExplicitReattach.ok || !rExplicitReattach.attached) {{
            throw new Error("Expected explicitStart BATCH_ATTACH to succeed");
          }}

          // Repeated attach on already-attached tab must NOT duplicate addScriptToEvaluateOnNewDocument
          const scriptsBefore = cdpSent.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument").length;
          const rReattach = await sendMsg({{ type: "BATCH_ATTACH" }});
          const scriptsAfter = cdpSent.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument").length;
          if (!rReattach.ok || scriptsAfter !== scriptsBefore) {{
            throw new Error("Repeated attach duplicated addScriptToEvaluateOnNewDocument");
          }}

          // Superseded quiescence wait resolves previous caller cleanly instead of returning already_waiting
          const pWait1 = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 5000, maxWaitMs: 5000 }});
          const pWait2 = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 10, maxWaitMs: 100 }});
          const [w1, w2] = await Promise.all([pWait1, pWait2]);
          if (!w1.ok || w1.reason !== "superseded" || !w2.ok) {{
            throw new Error("Quiescence supersede failed: " + JSON.stringify({{ w1, w2 }}));
          }}

          // Detach must NOT overwrite an already-finished batch (completedAt !== null, lastReason === null)
          let savedDetached = null;
          globalThis.chrome.storage = {{
            local: {{
              get: (k, cb) => cb({{ activeBatch: {{ completedAt: 12345, lastReason: null }} }}),
              set: (obj) => {{ savedDetached = obj.activeBatch; }}
            }}
          }};
          onDetachHandler({{ tabId: 42 }}, "canceled_by_user");
          if (savedDetached !== null) {{
            throw new Error("onDetach overwrote completed batch: " + JSON.stringify(savedDetached));
          }}

          print("BG_01_OK");
        }})();
        """
        assert "BG_01_OK" in run_jsc(js)

    def bg_02():
        js = f"""
        let fakeNow = 100000;
        Date.now = () => fakeNow;
        let tSeq = 0;
        const timers = new Map();
        globalThis.setTimeout = (fn, ms) => {{
          const id = ++tSeq;
          timers.set(id, {{ fn, ms: ms ?? 0 }});
          if ((ms ?? 0) < 100) {{
            Promise.resolve().then(() => {{
              if (!timers.has(id)) return;
              timers.delete(id);
              fn();
            }});
          }}
          return id;
        }};
        globalThis.clearTimeout = (id) => {{ timers.delete(id); }};
        const advanceTimers = (upToMs) => {{
          for (const [id, entry] of [...timers].sort((a, b) => a[1].ms - b[1].ms)) {{
            if (entry.ms <= upToMs && timers.has(id)) {{
              timers.delete(id);
              fakeNow += entry.ms;
              entry.fn();
            }}
          }}
        }};

        let onMessageHandler = null;
        let onEventHandler = null;
        let attachCalls = 0;
        let pendingAttachCbs = [];
        let holdAttach = false;
        let failEvalOnce = false;
        let failNextClick = false;
        let cdpSent = [];
        let storedBatch = null;

        globalThis.chrome = {{
          storage: {{
            local: {{
              get: async () => ({{ activeBatch: storedBatch }}),
              set: async () => {{}}
            }}
          }},
          runtime: {{
            lastError: null,
            onMessage: {{ addListener(fn) {{ onMessageHandler = fn; }} }}
          }},
          tabs: {{ sendMessage: () => Promise.resolve() }},
          scripting: {{ executeScript: async () => [{{}}] }},
          debugger: {{
            onEvent: {{ addListener(fn) {{ onEventHandler = fn; }} }},
            onDetach: {{ addListener() {{}} }},
            attach(target, ver, cb) {{
              attachCalls++;
              if (holdAttach) pendingAttachCbs.push(cb);
              else cb();
            }},
            detach(target, cb) {{ cb(); }},
            sendCommand(target, method, params, cb) {{
              cdpSent.push({{ method, params }});
              if (failEvalOnce && method === "Runtime.evaluate") {{
                failEvalOnce = false;
                globalThis.chrome.runtime.lastError = {{ message: "Debugger is not attached" }};
                cb();
                globalThis.chrome.runtime.lastError = null;
                return;
              }}
              if (failNextClick && method === "Input.dispatchMouseEvent") {{
                failNextClick = false;
                globalThis.chrome.runtime.lastError = {{ message: "Debugger is not attached" }};
                cb();
                globalThis.chrome.runtime.lastError = null;
                return;
              }}
              cb({{}});
            }}
          }}
        }};

        load({bg_file});
        const sendMsg = (msg, tabId = 7) => new Promise((r) => onMessageHandler(msg, {{ tab: {{ id: tabId }} }}, r));

        (async () => {{
          // 1. Not attached rejects commands cleanly
          const rNoAttach = await sendMsg({{ type: "BATCH_DISPATCH_CLICK_AT", x: 1, y: 1 }});
          if (rNoAttach.ok || rNoAttach.error !== "not_attached") throw new Error("Expected not_attached error");

          // 2. Concurrent BATCH_ATTACH serializes into a single chrome.debugger.attach
          holdAttach = true;
          const pA1 = sendMsg({{ type: "BATCH_ATTACH" }});
          const pA2 = sendMsg({{ type: "BATCH_ATTACH" }});
          await Promise.resolve();
          while (pendingAttachCbs.length === 0) await Promise.resolve();
          holdAttach = false;
          pendingAttachCbs.shift()();
          const [rA1, rA2] = await Promise.all([pA1, pA2]);
          if (!rA1.ok || !rA2.ok || attachCalls !== 1) {{
            throw new Error("Expected concurrent attach serialization (1 attach call): " + JSON.stringify({{ rA1, rA2, attachCalls }}));
          }}

          // 3. Quiescence ceiling timeout when XHR never finishes
          const pCeiling = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 200, maxWaitMs: 1000 }});
          onEventHandler({{ tabId: 7 }}, "Network.requestWillBeSent", {{
            requestId: "hung1",
            request: {{ url: "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=save" }}
          }});
          advanceTimers(1000);
          const rCeiling = await pCeiling;
          if (!rCeiling.ok || rCeiling.reason !== "ceiling" || rCeiling.saveXhrsObserved !== 1) {{
            throw new Error("Expected quiescence ceiling timeout: " + JSON.stringify(rCeiling));
          }}

          // 4. Stale (>15s) in-flight XHR gets pruned so quiescence resolves idle
          fakeNow += 16000;
          const pPruned = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 100, maxWaitMs: 1000 }});
          advanceTimers(100);
          const rPruned = await pPruned;
          if (!rPruned.ok || rPruned.reason !== "idle") {{
            throw new Error("Expected stale XHR pruning to resolve idle: " + JSON.stringify(rPruned));
          }}

          // 5. Ignored telemetry rJ0tlb and Network.loadingFailed
          onEventHandler({{ tabId: 7 }}, "Network.requestWillBeSent", {{
            requestId: "tel1",
            request: {{ url: "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=rJ0tlb" }}
          }});
          onEventHandler({{ tabId: 7 }}, "Network.requestWillBeSent", {{
            requestId: "fail1",
            request: {{ url: "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=save" }}
          }});
          onEventHandler({{ tabId: 7 }}, "Network.loadingFailed", {{ requestId: "fail1" }});
          fakeNow += 200;
          const pFailIdle = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 100, maxWaitMs: 1000 }});
          advanceTimers(100);
          const rFailIdle = await pFailIdle;
          if (!rFailIdle.ok || rFailIdle.reason !== "idle" || rFailIdle.saveXhrsObserved !== 0) {{
            throw new Error("Expected telemetry ignore & loadingFailed idle: " + JSON.stringify(rFailIdle));
          }}

          // 6. JS dialog auto-accept
          onEventHandler({{ tabId: 7 }}, "Page.javascriptDialogOpening", {{}});
          if (!cdpSent.some((c) => c.method === "Page.handleJavaScriptDialog" && c.params.accept === true)) {{
            throw new Error("Expected Page.handleJavaScriptDialog accept:true");
          }}

          // 7. Dead-session recovery on BATCH_ATTACH
          failEvalOnce = true;
          const prevAttach = attachCalls;
          const rRecover = await sendMsg({{ type: "BATCH_ATTACH" }});
          if (!rRecover.ok || attachCalls !== prevAttach + 1) {{
            throw new Error("Expected dead session Runtime.evaluate failure to trigger re-attach");
          }}

          // 8. Mid-dispatch 'Debugger is not attached' clears attachedTabId & resolves pending quiescence
          const pPendingQ = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 200, maxWaitMs: 1000 }});
          failNextClick = true;
          const rDeadClick = await sendMsg({{ type: "BATCH_DISPATCH_CLICK_AT", x: 10, y: 10 }});
          const rPendingQ = await pPendingQ;
          const rStatus = await sendMsg({{ type: "BATCH_GET_STATUS" }});
          if (rDeadClick.ok || rStatus.attached || !rPendingQ.ok || rPendingQ.reason !== "ceiling") {{
            throw new Error("Expected mid-dispatch detach error to clear attached state and resolve quiescence");
          }}

          // 9. forPhotoStep rejects paused/completed batch and BATCH_DETACH cleans up
          storedBatch = {{ completedAt: null, lastReason: "paused" }};
          const rInactive = await sendMsg({{ type: "BATCH_ATTACH", forPhotoStep: true }});
          if (rInactive.ok || rInactive.error !== "batch_not_active") {{
            throw new Error("Expected batch_not_active for paused batch");
          }}
          storedBatch = {{ completedAt: null, lastReason: null }};
          await sendMsg({{ type: "BATCH_ATTACH", forPhotoStep: true }});
          const pDetachQ = sendMsg({{ type: "BATCH_AWAIT_SAVE_QUIESCENCE", idleMs: 200, maxWaitMs: 1000 }});
          await sendMsg({{ type: "BATCH_DETACH" }});
          const rDetachQ = await pDetachQ;
          if (!rDetachQ.ok || rDetachQ.reason !== "ceiling") {{
            throw new Error("Expected BATCH_DETACH to resolve pending quiescence");
          }}

          print("BG_02_OK");
        }})();
        """
        assert "BG_02_OK" in run_jsc(js)

    runner.run_test(
        "BG-01",
        "Background service worker routes CDP attach, click, insertText, save quiescence, and detach events",
        bg_01,
    )
    runner.run_test(
        "BG-02",
        "Background quiescence ceiling, stale XHR pruning, concurrent/dead-session attach, dialog accept & detach cleanup",
        bg_02,
    )

    elapsed = time.time() - t_start
    print("\n" + "=" * 72)
    print(f"  SUMMARY: {runner.passed}/{runner.passed + runner.failed} passed ({runner.failed} failed) in {elapsed:.2f}s")
    print("=" * 72)
    if runner.failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
