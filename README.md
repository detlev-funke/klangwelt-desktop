# Klangwelt – Desktop app

An application for making music: multitrack editing with tempo and pitch
control, recording and cleanup via the microphone, melody recognition against a
large MusicXML library, and a sound workshop with descriptive sound parameters.

This repo is the **desktop app**: the Tauri shell (`app/`) with audio devices,
files, library downloads, an MCP server for agents and the command line, plus
the end-to-end tests. The core (Rust), the interface (TypeScript) and the
browser version live in the [klangwelt](https://github.com/detlev-funke/klangwelt) repo,
included as a Git submodule in the `klangwelt/` folder.

**Tech:** Rust (core, DSP, audio engine, library) · Tauri 2 (window/WebView) ·
TypeScript without runtime libraries (interface).

The app speaks English, German, French, Italian, Spanish, Dutch and Polish – it follows the system language, and the gear menu switches it.

## Quick start

Requirements: Rust (stable), Node.js (only for the TypeScript compiler).
On Windows, also the Visual Studio Build Tools (C++) and WebView2. The
C compiler also builds libopus for the Opus export (no CMake needed).

```bash
git clone --recurse-submodules https://github.com/detlev-funke/klangwelt-desktop.git
cd klangwelt-desktop
npm run setup        # fetch the submodule, install TypeScript for the interface
npm run build:ui     # interface → klangwelt/ui/dist
cargo run -p klangwelt
```

To work on the core: work in the `klangwelt/` folder and commit there
(it is its own repo), then commit the submodule's new state here
(`git add klangwelt`). To fetch the latest state: `git submodule update --remote`.

Tests of the desktop shell and the core:

```bash
cargo test --workspace
cd klangwelt && cargo test --workspace
```

### Interface tests

No extra packages needed: Node ships its own test runner (`node:test`). The
end-to-end tests launch the **real desktop app** and drive it through the
WebView2 debug port (Chrome DevTools Protocol):
* real mouse and keyboard, i.e. clicks, dragging, and Shift, Ctrl and Alt;
* evaluation inside the window;
* the Rust core runs along with it, as do the audio engine, the library and the MCP server.

```bash
npm run release
KLANGWELT_EXE=target/release/klangwelt.exe KLANGWELT_STUMM=1 npm run test:e2e
```

* **Isolated:** Each test file starts its own app instance with its own
  temp folder for the library and the WebView profile, and with free ports.
  A running Klangwelt and your library stay untouched.
* **In the background:** The test windows sit off-screen, without a
  taskbar entry and without focus (`KLANGWELT_HINTERGRUND=1`). You can keep
  working in the meantime. To watch: `KLANGWELT_TESTS_SICHTBAR=1`.
* **Silent:** Test instances cannot be heard (`KLANGWELT_STUMM=1`: playback,
  position and levels run, but only zeros go to the device). To listen in:
  `KLANGWELT_TESTS_LAUT=1`.
* **No microphone:** Tests that record take a WAV instead of a real device
  (`KLANGWELT_FAKE_MIC=<file>`: played into the recording in real time, in a loop).
* **Which program:** `KLANGWELT_EXE` selects a different one than
  `target/debug/klangwelt.exe` (after `npm run release`:
  `KLANGWELT_EXE=target/release/klangwelt.exe`).
* **Failures** save a screenshot under `tests/e2e/out/`.
* **Covered** (`tests/e2e/*.test.mjs`, over 90 tests):
  * Command line: help, `index`, `--mcp` (also with auto-start), opening a project file
    in the running app.
  * Transport: play, stop, repeat, metronome, tempo, undo.
  * Notes: selection, selection rectangle, moving with position display, Alt+click also
    beside the clip, length, deleting, transposing.
  * Ruler.
  * Library: adding, searching, choosing voices, listen/stop,
    time window, importing, browsing.
  * Libraries: migrating old indexes, creating, switching (separate search),
    renaming, deleting, importing a package from its folder, restart.
  * Sound: three fields (a starting point changes only its own field, a drag is one
    undo step, hiding), synth envelope (presets, pulse, drawing
    curves), agent.
  * Harmony: moods, legend, paths, cadence cards.
  * Fugue and checker.
  * Project: tracks, demo, save/open.
  * Agent (MCP) and chat.
  * Windows, settings, expression, audio analysis, sound.
  * Recording with the live analysis (note, level, key, tempo) and the finished analysis.
* **Not testable automatically:** a real microphone and downloading the PDMX library.

The library's test pieces are written as MusicXML at runtime by
`tests/e2e/fixtures.mjs`.

The interface's unit tests and the tests of the browser version live in the
klangwelt repo (`klangwelt/ui`: `npm run test:unit`, `npm run test:web`).

## Using Klangwelt

| Key | Action |
|---|---|
| Space | Play / pause – if a time range is selected, it plays exactly that range (looped with Repeat, otherwise once and then back to its start); without a selection it stops one bar after the end of the piece |
| R | Start / stop recording |
| Enter / Home (■ button) | Stop: playback position and view back to the start |
| L (⟲ button next to the metronome) | Repeat on/off: at the end of the piece (or of the selected range), start again from the beginning |
| Metronome button | Click on/off – Klangwelt remembers the state until the next launch (`einstellungen.json`) |
| Speaker button at the top right (device · kHz) | Choose the output device: "System default" or a specific device. Takes effect immediately – a running playback continues on the new device – and applies at the next launch (`einstellungen.json`). If the remembered device is missing then, the system default plays and a short notice appears |
| Microphone button next to it | Choose the input device (for recordings and for singing a melody in the library), also remembered; locked during a recording |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+O / Ctrl+N | Open project / New project |
| Del | Delete the selected notes, otherwise the selected clip (or track). If a **time range was selected** last (or nothing else is selected), Del deletes that range from all tracks – see [Deleting a time range](#deleting-a-time-range) |
| Right-click in the timeline | Context menu: quantize selected notes to the beat, transpose, delete · convert an audio clip into a melody or rhythm track · delete the selected time range |
| Drag audio files onto the window | one audio track per file with a clip starting at the mouse position – see [Inserting audio files](#inserting-audio-files-and-converting-them-to-notes) |
| Ctrl + mouse wheel | Zoom the timeline |
| Shift + mouse wheel | Scroll horizontally |
| Shift while dragging | Move a clip without snapping to the grid |
| Drag the ruler | Pan the view (time moves with the mouse) |
| Click in the ruler | Set the playback position |
| Shift/Ctrl + drag in the ruler | Select a time range (beats, bars when zoomed out; Alt: free) – with Repeat, this is the loop |
| Drag the edge of the range / Shift+click in the ruler | Adjust the range / clear it |
| Double-click an audio clip | Open the analysis |
| Drag the line between two tracks | Change the track height (in the track header or in the timeline) |
| Double-click this line | Default height |
| F1 | Open the help window and pin the text for the element under the mouse (again on the same element: unpin) |
| Ctrl+E | Export |

### Saving and opening projects

On the left of the toolbar: **File ▾** (New project, Open, Save,
Save as, Load demo project) and the **Save** button. A dot
on the button and "•" after the project name indicate unsaved changes.

- A project file `*.klangwelt` is a ZIP: `projekt.json` (tracks, clips,
  notes with expression, sounds, tempo) and, under `audio/`, every recording used,
  as a WAV (32-bit float, mono). So the file is complete and can be
  passed on.
- Default folder: `Documents/Klangwelt/Projekte`. In the dialog a name is enough;
  a full path saves elsewhere. "Open" lists the folder
  (newest first) and also accepts a path.
- Saving is atomic (first `*.klangwelt.teil`, then rename), so that a
  crash never leaves a half-written file.
- New project, Open, Demo and closing the window ask when there are
  unsaved changes: Save / Don't save / Cancel.

### Inserting audio files and converting them to notes

Simply drag audio files from Explorer onto the window:

- **Over the timeline**, the position counts: the clip starts on the beat
  under the mouse (to the sixteenth when zoomed in). Dropped onto an
  **audio track**, the file lands in that track; otherwise a
  new audio track is created – below the track under the mouse, or at the end. While dragging,
  a line and a label show where it will go ("Audio file → bar 2.1.1 ·
  new track").
- **Over a track header**: into this audio track (or below this instrument track), from the start.
- **Several files**: one track per file; dropped onto an audio track,
  the first goes into it and the others become new tracks directly below.
- Everything is one undo step. The clips play at their **original tempo**
  ("Detect tempo" in the Clip window then makes them follow the project tempo).
- **Formats** (own decoders, detected by content, not by extension):
  WAV (PCM 8/16/24/32-bit, floating point 32/64-bit, also WAVE_FORMAT_EXTENSIBLE),
  AIFF/AIFC, FLAC (complete) and Ogg Opus. Klangwelt cannot read **MP3, AAC/M4A, Ogg Vorbis and
  WMA** yet – the message says so and lists the
  readable formats; from a mixed selection, the readable files are
  still inserted. Stereo is averaged to mono (as with recordings); up to 30 minutes per file.
- MusicXML files and folders are still taken by the library when its
  window is open.

**Convert to notes:** Every recording and every inserted audio file has the
**♪ → Notes** button in its header: it creates the detected notes as a **melody track**
directly below (quantized to sixteenths, one note clip at the same
position, length in whole bars; if the melody is low, it becomes a bass track).
In the pitch view of an audio track, the same button ("Notes") also sits in the
track header and converts all audio clips of the track. **Right-clicking** the
clip also offers **Convert to rhythm track**: the detected onsets
become a drum track – each onset a kick, snare or hi-hat depending on
its timbre (what it adds compared to the sound before: lots of low end = kick,
lots of high end = hi-hat, otherwise snare), kicks additionally taken from the low band, and a hi-hat
on the kick if it is as bright as the other hi-hats. Each is one undo step.

### Deleting a time range

Select a range with Shift/Ctrl+drag in the ruler, then press **Del**
(or right-click in the range → "Delete time range"): the range
disappears from **all** tracks and **everything after it moves up** – no
gap remains (like "ripple delete" in other programs). It was decided this way
because "delete" would otherwise just leave a silent spot that you would have to
close by hand; if you want a gap, just move the clips afterwards.

- Clips entirely inside the range are removed; clips after it move forward by the length of the
  range.
- A clip crossing an edge is shortened or split: in note clips,
  the notes inside the range are removed; a note crossing the edge becomes shorter by its share inside the
  range (a held note stays one note). In audio clips, the
  material before and after the range is kept, joined seamlessly (with a 3 ms
  crossfade against clicks) – as a new audio file in the project; the original is kept
  for undo.
- One undo step ("Delete time range (bar 1.3 – 2.2)"); the
  selection is cleared afterwards.
- What Del deletes is decided by the last selection: if you click
  notes or a clip after selecting the range, those are deleted again; selecting a range itself
  clears a note selection.

### Exporting

The **Export** button next to "Save" (also **Ctrl+E** and in the "File" menu).
What you hear is exported: muted tracks are left out, solo applies.
Rendering uses the same mix as playback, at 48 kHz stereo.

| Format | What for | Setting |
|---|---|---|
| **WAV** | uncompressed – further editing, mastering | 24-bit (default) or 16-bit with dither |
| **FLAC** | lossless compressed, smaller than WAV (at 16-bit about half) | 24 / 16-bit |
| **Opus** | small, for listening on a phone and sending (`.opus`, plays on Android, iOS 17 and later, browsers, VLC) | 64–320 kbit/s, default **160** – hardly distinguishable from the original |
| **Stems** | a folder with one WAV per audible track, all the same length – for further mixing elsewhere | 24 / 16-bit |
| **MIDI** | only the notes of the instrument tracks, with tempo and time signature (type 1, 480 ticks per quarter note; drums on channel 10) | – |

- **Whole piece or selected range:** If a time range is selected in the timeline,
  the "Selected range only" checkbox exports exactly that range.
  The whole piece includes the tail (reverb) until it has died away –
  at most one bar plus 6 seconds.
- **Location:** `Music/Klangwelt/Exporte`. A name is enough; a full
  path saves elsewhere. If the file already exists, the dialog warns and
  overwrites it.
- Afterwards the dialog shows the file, size and length and, if you like, opens the
  folder in Explorer. It remembers format, bit depth and bitrate.
- WAV, FLAC (fixed predictors, Rice coding, mid/side, MD5) and the
  Ogg container are our own code; Opus encoding is done by
  [libopus](https://opus-codec.org) (BSD license, bundled in
  `crates/klang-opus/opus`).

### Help and intro tour

- **Intro:** On the page of an empty project, the **Intro** button starts
  a tour of all windows. The current window is highlighted
  (the rest is dimmed), a large note explains it, and small sticky notes are attached
  to individual features. → or Enter to continue, ← to go back, Esc to quit. Afterwards
  the tabs are open just as they were before.
  So that the windows have something to show, the tour loads the **demo** and fills every
  window: the "Theme" clip in the Clip window, the analysis of the arpeggio recording, the
  sound of the melody, the fugue subject, the circle of fifths at bar 2. With "Done"
  or Esc the demo disappears again (one undo step); with
  "Keep demo" it stays. The lower windows get more height during their
  step; if you close the app in the middle of the tour, the tour ends first.
- **Help window:** A small window shows a more detailed text for the element under the mouse,
  with the relevant keys and mouse gestures, and above it the
  element's tooltip. **F1** pins the text (lock at the top right) and
  opens the window in any case – even if it was closed. F1 on another
  element pins that element's text; F1 on the same one (or a click on the
  lock) unpins it. It starts as a floating window and, like any
  other, can be docked or shown and hidden via "Windows ▾".
- **Tooltips:** Every control has one – on itself or on its frame
  (an e2e test checks this).

### Windows (docking system)

Tracks, Clip, Analysis, Sound, Rhythm, Library and Agent are separate windows.
Default: Tracks at the top, Clip/Analysis/Sound/Rhythm/Library below as tabs,
Agent on the right. You open a new window (e.g. Rhythm) in a
saved layout via "Windows ▾".

| Window | Action |
|---|---|
| Drag a tab | Target cross in the middle of a window: dock beside/above/below or (center) add as a tab |
| Drag a tab onto a tab bar | insert as a tab at that position (also to change the order) |
| Drag a tab onto an edge marker | dock along the full height/width at the edge |
| Drop a tab anywhere else | floating window (resize by dragging its edges/corners) |
| Drag the empty area of the tab bar | move the whole group or floating window |
| Drag the line between windows | resize (double-click: equal sizes) |
| × on the tab / middle mouse button | close the window – "Windows ▾" reopens it in its old place |
| "Windows ▾" → Reset layout | default arrangement |
| Esc while dragging | cancel |

The layout is saved. Narrow windows arrange their content in a single column.

### Note view

Each track can be switched in its track header between **Compact** and **Notes**
(piano keys icon). Instrument tracks start in note view.

The piano keys are like a piano rotated by 90° that you sit at from the left:
key fronts on the left, black keys at the back (right), **low notes at the top**.
The **gear** at the top right (Settings → Pitch axis) switches this to
**high notes at the top** (as in sheet music); this also applies to Analysis and
Library, and dragging and the mouse wheel follow the direction.
The visible pitch range adapts automatically to the content – even below
the piano's range (down to MIDI 0) – and can be scrolled and zoomed.

| In note view | Action |
|---|---|
| Click a note | select (Shift/Ctrl+click: add or remove) |
| Drag on an empty lane | selection rectangle: all notes inside (Shift/Ctrl: add to the selection) |
| Drag a selected note | move all selected notes (time and pitch, direction as on the pitch axis), Shift: without the grid. Meanwhile the timeline clearly shows bars, beats and the snap grid, the ruler the new range, and a label the position ("Bar 3.2.1 +1 beat · +2 st") – the same when moving clips |
| **Alt+click** on an empty lane | place a note; drag to the right: it ends at the pointer. Next to a clip, the note goes into the nearest clip of the track, which grows by whole bars – to the right or left (indicated with a dashed outline while dragging). Only in a track without a clip is a new one (1 bar) created |
| Drag the right edge of a note | change the length |
| Del | delete the selected notes |
| ↑ / ↓ (Shift: octave) | move the selected notes by a semitone (an octave) – each press is one undo step; has no effect while an input field has focus |
| Right-click a note | menu for the selected notes (an unselected note is selected first): **quantize** to 1/4, 1/8, 1/16 or the view's grid – only the starts, or start and length (each note stays at least one grid step long; calculated in the piece's bars, even if the clip starts offset), transpose (±1, ±octave), delete |
| Esc | clear the selection |
| Double-click an empty area | create a new note clip (1 bar) |
| Piano keys: mouse wheel / Ctrl+mouse wheel | scroll / zoom the pitch range |
| Piano keys: double-click / click | fit the pitch range / play the note |
| Alt + mouse wheel over the row | scroll the pitch range |
| Drag the name strip at the top | move the whole clip |

### Expression of individual notes

Besides pitch and length, every note has an **expression**: velocity (1–127),
vibrato (depth, sets in with a delay), brightness (darker/brighter than the
basic sound) and bend (scoop: the note starts offset and glides
in). Pluck and Bass apply all of these, Drums apply velocity and brightness.

* **On the note:** opacity shows the velocity, a wavy line the vibrato,
  an arc the scoop, a bright edge the brightness.
  **Alt + drag** on a note changes the velocity (with a selection: of all
  selected notes), **Alt + Shift + drag** the vibrato.
* **Expression lane** below the rhythm strip (the button with the lollipops in the
  track header shows/hides it; choice on the left: Velocity, Vibrato, Brightness,
  Bend): drag values or **paint** across several notes; **Shift** draws a
  straight line – that's how you make a crescendo; **double-click** resets. If
  notes are selected, only those change.
* **Performance markings** in the **Clip** window (for the selection or all notes):
  *pp p mp mf f ff*, cresc./decresc., accent `>`, staccato `·`, legato `⌒`,
  Vibrato, Brighter/Darker, Scoop, Neutral – plus a slider with the
  average value for each.
* The agent uses the same values (`velocity`, `vibrato`, `brightness`, `bend`
  in `setClipNotes`), e.g. "Play the last two bars crescendo with vibrato".

In note view, audio tracks show what the analysis detects (display only):

* **Melodies** (vocals, humming, bass down to E1): note boxes, for held notes
  with a pitch curve (intonation, vibrato).
* **Onsets with a fundamental** (kick, snare shell, toms, plucked bass):
  a diamond at their pitch.
* **Unpitched hits** (hi-hat, shaker …): in the **rhythm strip** at the bottom.

Several notes sounding at the same time (chords) are only partly detected.

### Sound workshop ("Sound" tab)

"+ Instrument ▾" creates a **Pluck**, **Organ**, **Harpsichord**, **Bass**,
**Synth** or **Drums** track with a 4-bar pattern. In the
**Sound** tab you shape the sound in **three fields**: drag the point or click a
named **starting point**. Each field sets only its own sliders; a
starting point in one field changes nothing in the others.

| Field | horizontal × vertical | sets |
|---|---|---|
| **Character** | per instrument, e.g. drums crisp → juicy → full → mighty × simple → complex | many of the instrument's sliders at once |
| **Timbre** | dark → bright × smooth → rough | `farbe` (tilt filter), `rauheit` (flutter 30–80 Hz, saturation, grain) |
| **Space** | narrow → wide × near → far | `breite` (stereo, lows stay centered), `raum` (reverb; quieter and duller from a distance) |

Timbre and Space can be hidden at the top (the setting is kept).
The **Preview** toggle sets what sounds briefly after you let go:
"Off", a **single note** (for drums a kick hit) or the
**pattern** (chord, beat, bass line); the choice is kept. Below, the
**Over time** view shows the waveform of the test sound, **Fine-tuning** lists all
sliders individually, and on the right are the measurements (brightness, decay, fundamental …).

**Synth** – for pads and long sounds: up to seven detuned voices per
note, sub, "shimmer" an octave higher, a filter with slow movement. You draw the
**envelope** yourself: volume and brightness as curves over
time (drag points; double-click adds or removes a point), plus
pulse in time (¼, ⅛, 1/16) with depth, and the release after letting go.
Presets: Swell, Bell, Breathe, Bloom, Pulsate, Waves, Gate, Stab.

**My sounds** – on the right of the Sound window you save the current setting
under a name (Enter or "Save"; without a name the suggestion is used, e.g. the
selected starting point). Everything is saved: every slider, the position in the
fields and, for the synth, the drawn envelope. The sounds apply in every
project; one click loads one into the track (one undo step). Whatever is
currently set is highlighted – after a change, no longer. A name that
the instrument already has turns "Save" into "Replace". ✎ renames, the
trash can deletes on the second click. Under "Other instruments" are the
sounds of the remaining instruments; choosing one turns the track into that instrument.

* **Drums** (General MIDI mapping: 36 kick, 37 rim, 38 snare, 39 clap,
  41/45/48 toms, 42 closed hi-hat, 46 open hi-hat, 49 crash, 51 ride, 56 cowbell,
  70 shaker) – every drum has a tunable **fundamental**; the kick
  is best tuned to the key. Rim follows the snare shell; cymbals,
  cowbell and shaker follow the brightness and length of the hi-hat.
  Starting points: Techno, House, Lo-Fi, Rock, Disco, 808, Trap, Hardstyle.
* **Bass** – subtractive (saw/square, low-pass with envelope, sub-octave,
  bite/saturation, glide on tied notes). Starting points: Finger, Pluck Bass,
  Acid, Growl, Sub Bass.
* **Synth** – Starting points: Glass, Warmth, Pulse, Strings, Choir, Ocean,
  Cathedral, Mist.
* **Pluck** – physical string model. Starting points: Muted, Warm, Harp,
  Bright, Crystal.
* **Organ** – pipe organ with the stops Subbass 16′, Principal 8′, Flute 4′,
  Quint 2⅔′, Octave 2′ and Mixture, plus wind noise and tremulant. Low
  pipes speak more slowly. Starting points: Flutes, Principal, Cornet, Pedal,
  Plenum (the tremulant is set in Fine-tuning).
* **Harpsichord** – 8′ and 4′ string choirs, lute stop, plectrum (soft ↔ sharp),
  resonance. Hardly any dynamics, as on the real instrument; when you let go, the
  damper can be heard faintly. Starting points: Lute, 8′, 8′+4′, Brilliant.

### Rhythm ("Rhythm" tab)

Drum patterns of typical genres as a **quick start** and a
**step grid** as an input aid – one row per drum, 16 sixteenths per
bar, the bright columns are the beats 1 2 3 4. In the drums' Sound window,
"Genre patterns …" leads here. In an empty project,
**"Start with a beat ▾"** offers the same templates: one click creates a
drum track with four bars, applies the genre's tempo and sound (one
undo step) and opens the clip here.

* **Genres:** Basics, House, Techno, Electro, Hip-Hop / Boom Bap, Trap,
  Drum & Bass / Jungle, Funk / Breakbeat, Rock / Pop, Reggaeton / Dancehall,
  Reggae / Dub, Latin / Afro-Cuban, UK Garage, Dubstep – 33 patterns with tempo,
  recommended swing and a tip (based on the freely available booklet
  "Pocket Operations"). "Use tempo …" sets the project tempo.
* **Draft:** Without a selected drum clip, the grid is a draft.
  "Write to track" creates it as a clip – in a drum track after
  its last clip, or in a new drum track with the genre's sound
  (House sounds like House, Trap like Trap …).
* **Editing a clip:** If a drum clip is selected (also right after
  writing), the grid shows that clip. Each click sets or removes a
  hit in the clip (one undo step), a pattern replaces the content,
  "Bars" changes the length (1, 2 or 4 bars, pages "Bar 1 … 4"), swing
  delays every second sixteenth. Notes on other keys stay as they
  are.
* The app sets the accents itself: backbeat loud, snares in between soft
  (ghost notes), hi-hats on the in-between sixteenths softer.
* "Listen" plays the grid at the project tempo (short patterns twice), the
  current column lights up along with it; clicking a drum name plays that drum.
  Rarely used drums (crash, ride, cowbell, toms, shaker) are under
  "More drums" and appear on their own as soon as a pattern uses them.

### Song ("Song" tab)

Templates for whole pieces that don't think strictly in the bar grid but in
**structure**: a trance song starts with pads, adds arpeggio and kick,
then bass, hi-hats and clap, has a break with a lead, a build-up with a
snare roll, and peaks. Templates: **Trance, Ambient, Deep House,
Synthwave, Lo-Fi** – in an empty project also via **"Start with a song ▾"**.

The **mini editor** shows the structure as a grid:

* **Columns = sections**, as wide as their bars. In the header: name, bars,
  type and ◀ ▶ (move), ⧉ (duplicate), × (remove); "+ Section"
  appends one. The **type** shapes the section: *Build-up* gets louder and
  brighter over its length (the brightness of the notes opens the filter) and ends –
  if "Transitions" is on – in a snare roll, *Peak* starts with
  a cymbal, *Outro* fades out.
* **Rows = roles:** Pad, Arpeggio, Bass, Lead, Kick, Hi-hats, Clap,
  Percussion, Transitions – each with its own sound (starting points from the
  Sound window, for the synth with an envelope).
* **Cells:** a click switches **off → sparse → full**, Shift+click goes back.
  Sparse means e.g. arpeggio in eighths instead of sixteenths, bass on the
  "and" instead of rolling, hi-hats only open on the offbeat.
* At the top: tempo, key and **chords** (German note names as in the circle of fifths,
  e.g. "a F C G", or scale degrees) with the bars per chord.

**Generate song** writes the tracks from this – one per role, all drums
together in "Beat", one clip per section – sets the tempo and 4/4 and zooms the
timeline to the whole song. Generating again **replaces** the most recently
generated song tracks (one undo step brings them back), so you can try
out structures quickly. The plan in the editor survives restarts;
during playback the section currently playing is highlighted.

### Agent chat ("Agent" tab)

You write tasks for the connected agent in the **Agent** window (Enter
sends). The agent picks them up via `chat_poll` (long poll), works through them using the
other MCP tools and replies with `chat_reply`. Each message shows its number and
status (waiting → in progress → done, or cancelled) and who took it ("claimed by zuhoerer").
The indicator at the top right tells you how the agent is doing: **Agent listening**
(a `chat_poll` is waiting for tasks), **Agent working on #n** (a task is in progress, or a
tool call within the last minute), both at once (**Agent listening · working on #3**),
**Agent ready** (an agent is connected but quiet) or **No agent connected** – only after
more than a minute without any sign of the agent.
Each message automatically carries the **context**
(shown in small print below it): which tracks are audible, muted or soloed (with
their ID) and which time range is selected in the tracks – so "make this
louder" refers to what is currently playing and selected.

**Roles**, so that someone always listens while others work: a **listener**
(subagent on a small, fast model) only calls `chat_poll` and confirms every task at once
with `chat_reply` (done=false); the **dispatcher** (the main session) starts a
**worker** subagent for each task and passes follow-ups on to it; the worker carries
out the task and finishes with `chat_reply` (done=true). At most one worker per track;
project-wide changes (tempo, delete range, generated song) one after another. All of
this is in the connection prompt (see [Connecting an agent](#connecting-an-agent)); the
listener's and the worker's tasks are the MCP prompts `zuhoeren` and `arbeiten`.

**Nothing gets lost:** `chat_poll` reserves a task for its client instead of using it
up. Without a `chat_reply` within `leaseSeconds` (default 60) it is offered again – if a
listener crashes or a second poller (a test, say) snatches it. `chat_peek` shows new
messages without taking them away from the listener.

**Stop:** the **Stop** button at a task – or a message like "Stop" / "Stop #3" – cancels
tasks nobody has picked up yet. For a task in progress every tool response carries
`cancelRequested: [3]` until the agent finishes it, so the worker notices without asking.
The listener keeps listening; it ends only when you explicitly ask it to stop listening.

**Waiting time:** `chat_poll` responds immediately when a task arrives, and otherwise
after `timeoutSeconds` (up to 590 s) with an empty list. The prompt uses 280 s,
so the listener asks again about every 5 minutes. If a client gives up earlier,
the server notices: the task stays queued, and the next poll receives it
together with a hint to shorten the waiting time.

### Library ("Library" tab)

**One library = one index.** Everything goes into the active library –
normally "Default": downloaded packages, added folders and
individual files. Only the active one is searched; there is no combined search across
several. The program remembers which one is active
(`bibliotheken.json` in the library folder) – no matter how it is started.

Its name is shown at the top of the window. Clicking it opens **Libraries**:
a list with scores, packages and folders; **Switch**, **New**
(empty, becomes active right away – e.g. for trying things out without changing
"Default"), **Rename**, **Delete** (only the index, never scores;
"Default" stays). The index files are in `Indizes\` in the
library folder.

New scores are indexed on their own and then **merged** with the
library's index – nothing is read again (a small package into
a library with 254,000 scores: a few seconds). What the library
already has does not get in twice (it recognizes PDMX files by their
ID, even in other folders). A package that is already included shows
"in "Default"" in the catalog; the full PDMX contains the sample and the selection.

On the first launch with this version, "Default" is created from the old
per-package-folder indexes (`klangwelt-bibliothek.kwix`), which then disappear.
If the full PDMX is among them, the sample and the selection become libraries of their own.

**Downloading:** Without scores of your own, a click on **Download** is enough
(it opens by itself as long as the library is empty):

| Package | Scores | Download | On disk | Duration (≈ 3 MB/s) |
|---|---|---|---|---|
| PDMX – Sample | 3,000 | 21 MB | 50 MB | ≈ 10 s |
| PDMX – Selection | 30,000 | 220 MB | 380 MB | ≈ 1.5 min |
| PDMX – Complete | ≈ 254,000 | 1.9 GB | ≈ 3.5 GB | 5–15 min + indexing (estimated) |

The complete dataset asks for confirmation before starting (second click). The index
lives on disk: searching needs about 0.2 GB of RAM, building it
about 0.2–0.4 GB.

The source is [PDMX](https://zenodo.org/records/15571083) (Long et al. 2024):
public-domain or CC0 scores from MuseScore, dataset under CC-BY 4.0 –
please cite the paper in publications (it is also in `QUELLE.txt`
in the target folder). The app downloads the archive using the operating system's `curl`,
unpacks it as a stream (the packages are the beginning of the large archive, so
a colorful mix) and then automatically imports it into the active
library. This is one single long connection (no individual requests per
score): if it drops, the app resumes at the same position after a short pause
(HTTP Range) – "Connection interrupted … resuming at 812 MB" – and the
unpacking doesn't notice. Only when five attempts in a row make no
progress does it give up. You can cancel at any time; starting again
skips files that are already there. If a package's scores are already in the folder
(card "in folder"), the button is called **Import** and nothing is downloaded.

**Several packages at once:** If a download is already running (or indexing
or importing is in progress), the button on the other cards is called **Queue**. The package
goes into the **queue** and starts on its own as soon as the current
job is finished – one after another, each into the library that was active when it was
queued. The queue is shown below the window's toolbar;
the × removes a package again (as does a click on "Waiting · position n"
in its card), "Remove all" empties it. **Cancel** stops only the
current job; then the next one starts. Queuing the same package twice is not
possible (not even a small PDMX package if a larger one is already waiting). The
queue only lives as long as the app is running; on closing, the
confirmation dialog names the waiting packages.

After downloading, genre and composer are loaded, and the scores are
indexed and imported, without any action on your part. If the app is closed or
crashes during this, it continues automatically at the next launch (into the same
library). The state is kept in `klangwelt-auftrag.json` in the package folder; the
file disappears as soon as the scores have been imported. A download
interrupted midway is only reported; "Download" resumes it.

While downloading or indexing, the "Library" tab shows a
dot. On closing, the app asks ("Keep running" / "Close
anyway"). For tests, the library folder can be redirected with
`KLANGWELT_BIBLIOTHEK`.

**Browsing (tree view):** the **Search | Browse** toggle in the window. The
library appears as a tree whose **levels** you choose freely and reorder by dragging
(e.g. *Genre › Composer* or *Mood › Instrumentation › Key*;
ready-made arrangements under **Presets**). Each level shows values with counts,
branches are expanded on demand, large lists page by page; clicking a piece
opens the score.

| Level | Values / source |
|---|---|
| Genre | Classical, Folk & traditional, Film & game music, Pop, Rock, Jazz, Sacred music … (MuseScore data from PDMX, multiple possible) |
| Composer | from PDMX or the MusicXML file, normalized (life dates removed, "Trad./anon." merged) |
| Difficulty | easy … very hard (MuseScore) |
| Mood, Coloring, Energy | from the analysis (valence/arousal: mode, tempo, register, density) |
| Major / minor, Key, Time signature, Meter, Tempo | from the score and the analysis |
| Instrumentation, Instrument group | number of voices; group from the voice names (multiple possible) |
| Texture, Harmony, Length | voice roles, chromaticism, number of bars |

Genre, composer and difficulty come from `PDMX.csv` (225 MB): it is read
along during the download (can be deselected) and only the rows for your own
pieces are kept (`pdmx-metadaten.tsv`); for libraries already downloaded, the
tree has a **Load genre & composer** button. About a third of the pieces
have a genre on MuseScore; the rest are under "unspecified". Older
indexes show a **Rebuild** button: the library is re-indexed from its
packages and folders (30,000 pieces ≈ 20 s).

**Your own scores:** Click **Add** and enter the path of a file or a folder
(`.musicxml`, `.xml`, `.mxl`, **kern; several separated by `;`) – or simply drag the
files onto the window. They stay where they are and go into
the active library.
You can search by title/composer/voice or by a **melody**, e.g.
`e d c d e e e` (German or English note names, MIDI numbers, durations with
`:`, e.g. `c:1 d:0,5`), or with **Search selection** for the selected notes
of a clip. With **Sing** you sing or whistle the melody into the
microphone. The button shows time and level; after **Stop** the notes are
detected and the search runs. Detection ranges from a male voice to a
whistle (60 Hz to 3.2 kHz); key and tempo don't matter. The recording does
not go into the project. The detected notes then appear in the melody field, where you can
correct them and search again. A word in the title field (e.g.
"Bach") narrows the results. The results view shows key, mood and the voice functions
(main theme, countermelody, inner voice, accompaniment figure, ostinato, cadential formula)
with the matching passage; **Voice as track** imports a voice into the project.

**Choosing voices:** A click selects a voice, **Ctrl+click** (or Shift)
adds more or removes them. The **☐ All voices** checkbox in front of the
voices selects all of them at once (again: back to the matching voice). Initially
the matching voice is selected; without a match (browsing), all are. Listening and
importing apply to the selection: **3 voices as tracks** creates one track
per voice (one undo step).

Below the voices, **▶ Match** plays the found passage with the
selected voices; without a match, the first eight bars. While it plays,
the button becomes **■ Stop**; afterwards it switches back on its own. In the
piano roll you drag out a **time window**
(snapped to beats, with Shift to whole bars). The edges can be
adjusted afterwards; a click outside clears the selection. The
buttons are then called **▶ Selection** and **Section as track**: only this
excerpt of the selected voices is imported, starting at beat 0. The track carries the bars in its
name, e.g. "… (bars 5–8)".

Above the piano roll is a **timeline** with bar numbers – as above the
tracks: **dragging** moves through time, a **click** sets the cursor,
Shift/Ctrl+drag selects a time window. The **mouse wheel** scrolls through
time, **Ctrl+mouse wheel** zooms around the mouse position, and with the middle mouse button
you can also drag in the roll itself. Only the visible
section is drawn, so even long pieces stay smooth at every zoom level.

### Harmony (circle of fifths)

The **Harmony** window (default: on the right above the agent chat) helps with
writing cadences and harmonic continuations:

- **Circle:** the major chords outside, the minor chords in the middle, the diminished
  chords inside. The chords of the key are colored, with their scale degree (I, ii, V …). The
  current chord is highlighted, the best continuations carry a
  rank number and an arrow. **Click** a chord to hear the transition
  from the last chord, **double-click** adds it to the **progression**.
- **Key:** estimated automatically from the notes or chosen explicitly. As soon as you
  work on the progression, it stays fixed.
- **Continuations:** grouped by kind – Close (authentic, plagal,
  deceptive cadence), Tension (to the dominant, cadential 6-4, double dominant),
  Continue, Color (secondary dominants, borrowings from minor, Neapolitan),
  Modulate (with target key). Each with scale degree, function (Riemann) and
  reasoning.
- **Frequency in the library:** If a library is loaded, each
  suggestion shows how often exactly this continuation occurs there, e.g. after G7 in
  major: C 48%, cadential 6-4 7%, deceptive cadence to a (A minor) 4%. In addition there are common
  continuations that no rule names (group "Common in the library").
  **Examples** lists passages from real pieces (composer, title, bar):
  ▶ plays the passage, **Open** shows the score in the
  "Library" window with the passage highlighted. The **All pieces | Baroque |
  Bach** toggle shows how these composers do it. An example: after G7, C follows
  in 48% of all pieces, but only in 33% with Bach, because Bach more often
  continues differently. The statistics require a rebuilt index; older
  index files show a **Reindex** button.
- **Mood of the transitions:** Arrows in the circle, dots in front of the suggestions
  and arrows in paths and cadences are colored by mood. The legend
  below the circle explains the colors; hovering over a mood highlights
  only its transitions.
  - **resolving** (green): dominant → tonic or target of a secondary dominant,
    leading tone upward, plagal cadence
  - **tense** (orange): to the dominant, double or secondary dominant,
    cadential 6-4
  - **surprising** (pink): deceptive cadence, chromatic mediant
    (C → A♭)
  - **bright** (yellow): to a major chord of the key
  - **dark** (blue): to minor or diminished, or borrowed from minor
- **Paths to a cadence** (below the circle): multi-step cadences from the
  current chord, up to four chords, for authentic cadence, plagal cadence,
  half cadence, deceptive cadence and (in minor) Phrygian half cadence. For each cadence
  the best path is shown, often with a **longer** variant below it, e.g. from C:
  G → C, longer F → G7 → C or F → C/G → G7 → C.
  - The steps follow the continuation rules. With a library loaded,
    the frequency of each step there counts for half, and under each arrow
    is the **transition probability** – how often exactly this step follows in
    the library's pieces (tooltip: mood and share).
  - If the window is wide (two columns), the paths are on the right below the
    progression; on the left, the circle and legend stand on their own and stay put while scrolling.
  - **Hovering** draws the path, numbered and in the mood colors, into
    the circle; a **click** pins it.
  - ▶ plays it from the current chord, **+** appends it to the progression,
    **To track** appends it and immediately writes it in four parts into the target track.
- **Cadences:** templates in the key (authentic, with Sp or s⁶₅, with
  cadential 6-4, plagal, half cadence, Phrygian half cadence, deceptive cadence,
  Neapolitan, Picardy third, lament bass, circle-of-fifths sequence), with
  colored transitions. When you hover over one, the circle shows the path (a click pins
  it), ▶ plays it.
  - **+ Append** appends it to the progression for further experimenting. The progression
    scrolls into view, the new chords light up briefly, and a hint
    names the next step.
  - **To track** appends it and immediately writes the progression into the target track.
- **Write to track:** The progression is voiced in four parts (chorale style:
  short moves, no parallel fifths and octaves, leading tones rise, sevenths
  fall) and written as notes. The target is the "Chords" track (created if
  needed) or a selected instrument track, after the chord at the cursor, with
  ½, 1 or 2 bars per chord, as one undo step. Two modes:
  - **Insert** (default): make room – everything after it moves back in all
    tracks by the length of the new chords; clips that span the
    position get longer.
  - **Replace:** whatever follows in the target track is overwritten.
  Afterwards the cursor is on the last new chord, and the progression continues from there.
- **Follows playback position** (checkbox below the progression, on): during playback
  and when setting the cursor, the progression picks up the harmony at that position –
  the chord there and up to three before it, detected from all instrument tracks.
  Your own new chords come after it; continuations and paths apply from there.
  "Clear" starts afresh until the cursor moves again.
- **Read from track:** detects the chords of the selected clip (without a selection:
  of all instrument tracks together) and continues the progression from there.
- **Harmony in the timeline:** The **Harmony** button in the tracks header
  shows the chord sequence of the piece at the bottom of the ruler – each chord a box in
  the color of its mood (as in the circle), with its name; the chord under the
  playback position lights up. While you work in the Harmony window, the
  strip appears by itself. **Harmonic breaks** are marked in red (an edge in the
  ruler, dashed through all tracks): a chord foreign to the key that can be explained
  neither as a secondary dominant nor as a borrowing from the parallel
  key nor as a Neapolitan, or a tritone leap of the root
  without a dominant. Hovering explains the chord, the transition and the break.

### Fugue and counterpoint ("Fugue" window)

A fugue subject is a note clip (2–4 bars). Choose it under **Subject**,
or click it in the timeline and press **Selection**.

- **Subject and answer:** The answer is real (a fifth higher) or tonal.
  If the subject begins in the area of tonic and fifth, the fifth is answered with the
  tonic; the altered notes are marked in red. You can hear the
  subject, the answer and both in sequence, and the answer can be created as a
  track. **Similar subjects** searches for the subject in the library, optionally
  only in pieces with "Fuge/Fugue/Fuga" in the title.
- **Transformations:** inversion (diatonic, around the first note), retrograde,
  retrograde inversion, augmentation, diminution and transposition by scale steps. In
  minor, the minor seventh before the tonic becomes a leading tone. Each transformation
  can be heard and created as a track.
- **Strettos:** entry distances and intervals at which the subject sounds together with
  itself without errors, the closest first.
- **Countersubject:** suggestions for a countersubject in a rhythm that
  complements the subject. Invertible counterpoint at the octave is also checked ("invertible"
  means: also free of errors below the subject).
- **Fugue plan:** builds a framework for 2–4 voices:
  1. Exposition: subject and answer alternating, countersubject in the voice that
     entered before, free voices generated.
  2. Episodes: sequence of the subject's head over a circle of fifths in the bass.
  3. Middle entries in the relative key and the subdominant.
  4. Stretto.
  5. Pedal point on the dominant.
  6. Final cadence, in minor with a Picardy third.

  The sections appear as a colored strip. **Listen** plays the plan,
  **Create fugue** writes one track per voice (organ with pedal in the bass,
  harpsichord or pluck) after the end of the project. The result is a
  starting point for further writing.
- **Counterpoint checker:** checks all instrument tracks, one voice per track.
  It finds:
  - parallel fifths and octaves
  - hidden parallels in the outer voices
  - voice crossing
  - unprepared dissonances on strong beats and free dissonances
  - range, large and augmented leaps, wide spacing

  The spots are marked in the timeline (red error, orange warning,
  blue hint); a click jumps there. With **Continuous**, it rechecks after every
  change. Voice names like Soprano/Alto/Tenor/Bass determine
  order and range.

## Connecting an agent

The running app provides an endpoint at `http://127.0.0.1:7419/mcp`:
JSON-RPC 2.0 over HTTP, as MCP specifies. **A prompt is all you need to
connect.** A click on the indicator at the top right opens the agent chat, where the prompt
is shown with a Copy button. Paste it into Claude Code, done – nothing needs
to be set up. The session then talks to the endpoint directly over HTTP (e.g. with curl):

* `initialize` returns the app's working instructions, `tools/list` the
  tools, `tools/call` calls one.
* To listen, it starts a listener subagent in the background (small model) that calls
  `chat_poll` (280 s) in a loop and hands every task to the session, which starts a
  worker subagent for it.
* If the server responds with 401 (token set, see below), it asks for the
  token.

The indicator at the top right shows "No agent connected" until an agent checks in,
then "Agent ready" or "Agent listening". An agent counts as connected as long as
it keeps a connection open – a waiting `chat_poll`, a running
tool call or an event stream (`GET /mcp`, which MCP clients open; after
it closes, the indicator switches back after about 3 s). Clients that only send individual
requests (curl, scripts) count for two minutes after their last
request; `DELETE` ends a session immediately.
Everything the agent changes appears immediately in the interface and lands in the
undo history ("Agent · …").

**Optionally set it up as an MCP server** – this is not necessary, but it still
works:

* Claude Code: `claude mcp add --transport http klangwelt http://127.0.0.1:7419/mcp`.
  The bundled [`.mcp.json`](.mcp.json) registers the server for Claude Code in
  this folder (with `"timeout": 330000`, so that long `chat_poll` calls don't abort after
  60 s).
* Claude Desktop and other stdio clients that have no shell:
  `klangwelt.exe --mcp` is a stdio bridge to the running app.
* It forwards every message to the app over HTTP.
* If Klangwelt isn't running yet, it starts it and waits until it responds.
* Entry in the client's MCP configuration (path after installation):

```json
{
  "mcpServers": {
    "klangwelt": {
      "command": "C:\\Users\\<name>\\AppData\\Local\\Klangwelt\\klangwelt.exe",
      "args": ["--mcp"]
    }
  }
}
```

Examples of instructions in the chat: "Make the melody warmer and softer",
"Create a bass track with a root-note riff in A minor", "Set the tempo to 92
and play", "Analyze my last recording and make an instrument track from it".

| Tool | Purpose |
|---|---|
| `get_project` | Read the project with track/clip IDs and its `revision`; `trackIds` / `fields` (e.g. `["tempoBpm", "tracks.name"]`) read only a part |
| `execute` | Project commands (JSON as in the interface) as one undo step; `ifRevision` refuses if someone changed the project in the meantime; placeholders (`"ref": "$bass"`, then `"trackId": "$bass"`) – the response lists the IDs; notes also compact (`"C4 1 · E4 .5 v100 · G4 .5"`) |
| `batch` | Several tool calls in a row as one undo step; stops at the first error and reverts the calls before it; `"$0.trackId"` uses a result of an earlier call |
| `undo` / `redo` | Undo / Redo |
| `transport`, `set_metronome` | Playback, position, metronome |
| `audio_devices`, `set_audio_device` | List or choose output and input devices (`null` = system default; takes effect immediately, applies at the next launch) |
| `export_project` | Export as WAV, FLAC, Opus (bitrate), stems or MIDI – the whole piece or the selected range |
| `chat_poll`, `chat_reply` | Fetch tasks from the chat (long poll; reserved for `client`, offered again without a reply within `leaseSeconds`) and reply to them (`done=false` confirms, `done=true` finishes) |
| `chat_peek` | New chat messages after `sinceId` without picking anything up (also `chat_poll {peek: true}`) |
| `list_instruments`, `create_instrument_track`, `set_instrument` | Create and switch instruments (Pluck, Organ, Harpsichord, Bass, Synth, Drums) |
| `describe_sound`, `set_sound`, `preview_sound` | Measure a sound, set it (including the synth's envelope and curves), preview it |
| `set_sound_field` | Point or starting point in a field (Character, Timbre, Space) |
| `list_saved_sounds`, `save_sound`, `load_saved_sound`, `rename_saved_sound`, `delete_saved_sound` | Sound library ("My sounds"): save, list, load, rename, delete |
| `list_song_templates`, `write_song` | List song templates, generate a whole song (also with custom sections, tempo, key, chords) |
| `list_drum_patterns`, `write_drum_pattern`, `read_drum_pattern` | List genre patterns, write one as a drum clip (also custom rows like `kick: "x...x..."`), read a clip as a grid |
| `analyze_clip`, `melody_to_track` | Analyze a recording, import the melody |
| `audio_to_notes` | Convert a recording into a melody track (`target: melodie`) or rhythm track (`rhythmus`: kick, snare, hi-hat) directly below; without `clipId`, all audio clips of the track |
| `import_audio` | Insert audio files (WAV, AIFF, FLAC, Opus) as tracks – with the `trackId` of an audio track into that track, from `startBeats`; unreadable files are returned with a reason |
| `delete_range` | Delete a time range from all tracks; everything after it moves up (clips are split or shortened, audio is cut) |
| `quantize_notes` | Quantize a clip's notes to the grid (`grid` in beats: 1 = quarter, 0.5 = eighth; `lengths`: the ends too; `notes`: indices) |
| `search_melody` | Search the active library for a melody |
| `list_libraries`, `switch_library`, `create_library`, `delete_library` | List, switch, create, delete libraries (one index each) |
| `download_library`, `add_to_library`, `library_status` | Import a package or files into the active library (in the background; if something is already running, the package is queued), query the status |
| `browse_library` | Explore the library as a tree (genre, composer, mood, instrumentation …) |
| `analyze_score` | MusicXML file: key, mood, voice functions, cadences |
| `analyze_harmony` | Key and chord progression (degrees, functions, mood, breaks) of a track, a clip or the whole piece |
| `suggest_chords` | Continuations after a chord progression with mood, frequency and examples from the library; multi-step paths to a cadence; cadence templates |
| `preview_chords`, `write_chords` | Play a chord progression in four parts or write it as notes (symbols like `G7`, `fis°` or degrees like `V7/V`; with `mode: einfuegen` whatever follows moves back) |
| `fugue_subject` | Fugue subject: answer (real/tonal), strettos, transformations |
| `transform_melody`, `countersubject` | Inversion, retrograde, augmentation … or an invertible countersubject as a track |
| `write_fugue` | Fugue framework for 2–4 voices as tracks (organ or harpsichord) |
| `check_counterpoint` | Part-writing errors with bar and tracks – for targeted fixes |

Every writing tool also returns what changed: the new `revision`, a short `change` and the
IDs it `created` (or `removed`) – no `get_project` needed afterwards. As long as the person
has asked to stop a task, every response (and every error) carries `cancelRequested`.

Environment variables:
* `KLANGWELT_MCP_PORT` – default 7419.
* `KLANGWELT_MCP_TOKEN` – then requires `Authorization: Bearer <token>`; the
  bridge reads the same variable.
* `KLANGWELT_MCP_URL` – for the bridge only.

The server listens only on 127.0.0.1 and rejects browser requests from other sites
(origin check).

## Command line

Everything is in one program, `klangwelt.exe`:

| Invocation | Effect |
|---|---|
| `klangwelt` | Open the window |
| `klangwelt <file.klangwelt>` | Open a project; if Klangwelt is already running, it opens there instead of in a second window (it asks if there are unsaved changes) – this is also how double-clicking project files works |
| `klangwelt --mcp` | stdio bridge for MCP clients (see above) |
| `klangwelt index build <folder> <index.kwix>` | Index the MusicXML/MXL files in a folder |
| `klangwelt index merge <target.kwix> <a.kwix> <b.kwix> …` | Merge indexes into one without re-indexing (duplicates only once) |
| `klangwelt index query <index.kwix> "60:1 62:1 64:2 65:1 67:2"` | Search for a melody (`MIDI-note:duration`, at least 5 notes; key and tempo don't matter) |
| `klangwelt index analyze <piece.mxl>` | Voices, cadences, mood as JSON |
| `klangwelt index chords <index.kwix> C-Dur C F G7` | Most frequent continuations after the last chord (`C-Dur` = C major), with examples |
| `klangwelt --help`, `--version` | Help, version |

During development: `cargo run -p klangwelt -- index build …`.

* **Output in the console:** The installed version is a GUI program.
  When called from a console, it attaches its output there.
* **Waiting for it to finish:** The Command Prompt does not wait for GUI
  programs. To wait, use `start /wait klangwelt index …` or, in PowerShell,
  `klangwelt index … | Out-Default`.

## Building a release (single file)

Klangwelt needs no installation. The release is a single file,
`klangwelt.exe` – interface, core, audio engine, library, agent server,
bridge and indexer are all inside it.

```bash
npm run release
```

This builds the interface and then the optimized app
(`cargo build --release -p klangwelt --features tauri/custom-protocol`). The
result is in `target/release/klangwelt.exe`. The file can be placed
anywhere and is started directly.

**What it needs:**
* WebView2. Windows 11 has it, and an up-to-date Windows 10 usually does too;
  otherwise it is available from Microsoft ("WebView2 Runtime").

**What it creates** (when used, not at startup):
* Projects under `Documents\Klangwelt\Projekte`.
* Libraries under `Music\Klangwelt\Bibliothek` (packages in their own folders,
  indexes in `Indizes\`, the list and the active library in `bibliotheken.json`).
* Your own sounds ("My sounds") in `Music\Klangwelt\Klänge\klaenge.json`.
* Exports under `Music\Klangwelt\Exporte`.
* Settings under `%LOCALAPPDATA%\dev.klangwelt.app`.

**Deliberately missing without an installer:**
* Start menu entry and uninstaller.
* The file association for `.klangwelt` – it can be set by hand via "Open with …";
  then a double-click opens the project in the running app.
* A code signature: without a certificate, Windows SmartScreen warns about an
  unknown publisher on first launch.

## License and legal

* **License:** Klangwelt is free software under the [MIT License](LICENSE) –
  free of charge, usable for any purpose, without warranty.
* **Third-party libraries:** All bundled Rust libraries are under
  free licenses (mainly MIT, Apache-2.0, BSD, Zlib, ISC, some MPL-2.0),
  plus libopus (BSD). The list and the license texts are in
  [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md); regenerate it after changing the
  dependencies with `npm run licenses`.
* **Score collections:** Klangwelt ships no scores. The library
  downloads them on request directly from the sources, and their licenses apply,
  which the window shows for each package: PDMX (dataset CC BY 4.0,
  scores public domain or CC0 according to MuseScore), OpenScore (CC0), KernScores
  (mostly CC BY-NC-SA 4.0, some collections without license information), DCML
  (CC BY-NC-SA 4.0). Use non-commercial collections only privately and credit the
  source.
* **Name:** Klangwelt is a free project and not affiliated with
  companies, brands or institutions of the same name.

Architecture and background: [klangwelt/docs/ARCHITECTURE.md](klangwelt/docs/ARCHITECTURE.md).
