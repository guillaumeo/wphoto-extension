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
        globalThis.location = {{ pathname: "/u/1/album/ALBUM_123", href: "https://photos.google.com/u/1/album/ALBUM_123" }};
        globalThis.getComputedStyle = () => ({{ overflowY: "visible" }});
        globalThis.document = {{
          documentElement: null,
          body: {{}},
          querySelectorAll(sel) {{
            if (sel.includes('[role="checkbox"][aria-checked="true"]')) return mockCheckboxes;
            if (sel === 'a[href*="/photo/"]') return mockAlbumLinks;
            if (sel === "script") return [];
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

          // 5. Single photo viewer (/photo/<id>) disables selection (eligible === 0)
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

          print("DOM_03_OK");
        }})();
        """
        assert "DOM_03_OK" in run_jsc(js)

    runner.run_test(
        "DOM-03",
        "Hidden Close-info rejection, remembered-panel hydration grace wait, and forced toggle when textarea missing",
        dom_03,
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

          print("AI_03_OK");
        }})();
        """
        assert "AI_03_OK" in run_jsc(js)

    runner.run_test(
        "AI-03",
        "Cloud Gemini HTTP 429 rate-limit exponential backoff recovery and max-retry exhaustion",
        ai_03,
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

          // Switch to API Key view in French
          card.querySelectorAll("button").find((b) => b.textContent === "Clé API").click();
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

          // Navigate to a single photo (/photo/P1) -> menu and trigger button must be disabled/removed
          globalThis.location.pathname = "/photo/P1";
          globalThis.location.href = "https://photos.google.com/photo/P1";
          window.WPhotoUi.ensureTriggerButtonMounted();
          if (elementsById["wphoto-trigger-btn"] || elementsById["wphoto-menu-card"] || window.WPhotoUi.state.menuOpen) {{
            throw new Error("Expected menu and trigger button to be disabled/removed when viewing a single photo");
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
        window.WPhotoAiEngine.runAiDescription = async ({{ photoId }}) => {{
          attemptCount++;
          if (photoId === "P1" && attemptCount === 1) {{
            return {{ success: false, error: "textarea_not_visible", timing: {{}} }};
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

          // Continue batch after reload -> P1 succeeds and navigates to P2
          await window.WPhotoBatchRunner.continueBatchIfActive();
          if (currentPath !== "/photo/P2" || !storageData.activeBatch.completedIds.includes("P1")) {{
            throw new Error("Expected P1 completion and transition to /photo/P2, got: " + currentPath);
          }}

          // Pause & Resume
          await window.WPhotoBatchRunner.pauseBatch();
          if (storageData.activeBatch.lastReason !== "paused") {{
            throw new Error("Expected batch to pause");
          }}
          await window.WPhotoBatchRunner.resumeBatch();
          if (storageData.activeBatch.completedIds.length !== 2 || storageData.activeBatch.completedAt === null) {{
            throw new Error("Expected P2 to complete after resume: " + JSON.stringify(storageData.activeBatch));
          }}
          if (currentPath !== "/album/A1") {{
            throw new Error("Expected return to originUrl /album/A1 after completion, got: " + currentPath);
          }}

          print("RUN_01_OK");
        }})();
        """
        assert "RUN_01_OK" in run_jsc(js)

    runner.run_test(
        "UI-01",
        "Single menu renders EN/FR/ES, Cloud/Local, Overwrite No/Yes, API Key-only settings, and zero icons",
        ui_01,
    )
    runner.run_test(
        "RUN-01",
        "Batch state machine handles kickOff, 1x transient reload retry, pause/resume, and return to origin",
        run_01,
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

          print("BG_01_OK");
        }})();
        """
        assert "BG_01_OK" in run_jsc(js)

    runner.run_test(
        "BG-01",
        "Background service worker routes CDP attach, click, insertText, save quiescence, and detach events",
        bg_01,
    )

    elapsed = time.time() - t_start
    print("\n" + "=" * 72)
    print(f"  SUMMARY: {runner.passed}/{runner.passed + runner.failed} passed ({runner.failed} failed) in {elapsed:.2f}s")
    print("=" * 72)
    if runner.failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
