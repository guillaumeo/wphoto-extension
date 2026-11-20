# AI Plus (`wphoto-extension`)

A Chrome Manifest V3 extension that generates concise, encyclopedic AI descriptions for your Google Photos library in multiple languages (**English**, **Français**, **Español**).

## Features

- **Flexible Batch Scope**: Process either manually selected grid photos or an entire album automatically, skipping videos and unowned shared photos.
- **Cloud & Local AI Models**:
  - **Cloud (Gemini API)**: Uses `gemini-3.1-flash-lite` / `gemini-3.1-flash-lite-preview` with aspect-preserving image resizing (`<= 768px`) and automatic HTTP 429 exponential backoff.
  - **Local (Gemini Nano)**: Uses Chrome's on-device `LanguageModel` API when available, with automatic metadata fallback (tagged people, place, and year) when local AI is unavailable.
- **Metadata-Aware Prompts**: Extracts tagged people's first names, untagged people counts, place names, and years from the Google Photos Info panel while following neutral documentary caption guidelines.
- **Photo Stack Propagation**: Detects photo stacks and shares the generated caption across items in the stack without redundant model calls.
- **Resilient Persistence**: Uses Chrome Debugger Protocol (CDP) trusted input, Info panel anti-flap recovery, and network save quiescence detection so captions save reliably across navigations.
- **Native UI & Controls**: Matches Google Photos light and dark themes with **Pause**, **Resume**, and **Cancel** controls, overwrite protection (`No` / `Yes`), and optional verbose log export (`ai_summary_log.txt`).

## Installation

### Option 1: From GitHub Releases (Recommended)

1. Download `wphoto-extension-v1.1.0.zip` from the [Releases](https://github.com/guillaumeo/wphoto-extension/releases) page.
2. Extract the archive to a permanent folder on your computer.
3. Open `chrome://extensions` in Google Chrome.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the extracted folder.

### Option 2: From Source

```bash
git clone https://github.com/guillaumeo/wphoto-extension.git
```

1. Open `chrome://extensions` in Google Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select the cloned `wphoto-extension` folder.

## Usage

1. Open or refresh `https://photos.google.com`.
2. Navigate to an album or select photos in the grid to display the **AI Plus** button in the top bar (it stays hidden on the home grid with no selection and in single-photo view).
3. *(Cloud mode)* Click **AI Plus → API Key**, enter a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey), and click **Save Key**. Your key is stored locally in `chrome.storage.local` and never sent anywhere other than the Gemini API.
4. Choose your **Language** (`English`, `Français`, `Español`), **Model** (`Cloud` or `Local`), **Overwrite existing descriptions** (`No` or `Yes`), and optionally enable **Verbose log**.
5. Click **Describe ...** to start the batch.
6. Monitor progress or **Pause** / **Resume** / **Cancel** from the bottom-right status bar.

> **Note:** While a batch is actively writing descriptions, Chrome displays an *"AI Plus started debugging this browser"* banner for trusted keyboard/mouse input and save-XHR quiescence detection. Leave this banner open until the batch finishes—clicking **Cancel** on the banner cancels the batch.

## Permissions & Privacy

- `storage`: Stores user preferences, active batch progress, verbose logs, and your Gemini API key locally.
- `debugger`: Dispatches trusted input events and monitors Google Photos `batchexecute` save network quiescence during active batch runs.
- `scripting`: Injects the local Gemini Nano `LanguageModel` bridge in the page's main world when using Local mode.
- Host permissions (`https://photos.google.com/*`, `https://generativelanguage.googleapis.com/*`, `https://*.googleusercontent.com/*`): Required to interact with Google Photos, read photo image bytes, and call the Gemini API.

## Adding a Language

Prompt templates and UI strings are driven declaratively by `prompts.js`. Add a new language key (matching the keys in `en`, `fr`, `es`, plus optional `ui` overrides) to `window.WPHOTO_PROMPTS` in `prompts.js` and reload the extension.

## Testing

Requires macOS JavaScriptCore (`jsc`):

```bash
python3 tests/run_tests.py .
```

## License

[MIT](LICENSE)
