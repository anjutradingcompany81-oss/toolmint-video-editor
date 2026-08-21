// Display-language strings for the AI Voice Correction panel — separate
// from the *content* being analyzed (the actual transcript stays in
// whatever language/script Whisper produced it in; this file only covers
// this panel's own labels, buttons, and explanations). Per spec: never
// mix languages within one rendered result — every string a given render
// pass uses comes from exactly one of these two objects, never both.
export type DisplayLang = "en" | "hi";

export interface VoiceCorrectionStrings {
  panelTitle: string;
  close: string;
  intro: string;
  sensitivity: string;
  transcriptSimilarity: string;
  audioSimilarity: string;
  maxGap: string;
  minSegmentDuration: string;
  confidenceThreshold: string;
  scanSelectedClip: string;
  scanSelectedClipHint: string;
  selectClipFirst: string;
  scanEntireTimeline: string;
  pause: string;
  cancel: string;
  paused: string;
  resume: string;
  scanFailed: string;
  tryAgain: string;
  scanCancelled: string;
  back: string;
  toReview: (n: number) => string;
  corrected: (n: number) => string;
  noRepetitions: string;
  newScan: string;
  suggestionsTab: string;
  scriptTab: string;
  correctAllHighConfidence: string;
  keepOriginal: string;
  removeDuplicate: string;
  replaceWithRoomTone: string;
  trimAudioVideo: string;
  playBefore: string;
  playAfter: string;
  speaker: string;
  original: string;
  repeated: string;
  correctedScript: string;
  undo: string;
  edit: string;
  save: string;
  cancelEdit: string;
  applyFix: string;
  applyCorrection: string;
  applyAllApproved: string;
  reviewRequired: string;
  noRepetitionDetected: string;
  loadingTranscript: string;
  noTranscript: string;
  readScript: string;
  correctScriptAction: string;
  editHint: string;
  batchTitle: string;
  batchDetected: string;
  batchSelected: string;
  batchDurationRemoved: string;
  batchNeedsReview: (n: number) => string;
  batchConfirm: string;
  batchApplying: string;
  kindWord: string;
  kindPhrase: string;
  kindSentence: string;
  kindClipOverlap: string;
  kindSceneJoin: string;
  kindRenderDuplicate: string;
  suggestTrim: string;
  suggestRoomTone: string;
  stageQueued: string;
  stageExtracting: string;
  stageDetecting: string;
  stageTranscribing: string;
  stageDiarizing: string;
  stageComparing: string;
  stagePreparing: string;
  stagePaused: string;
  analysisLanguage: string;
}

const en: VoiceCorrectionStrings = {
  panelTitle: "AI Voice Correction",
  close: "Close",
  intro: "Scan the timeline for accidentally duplicated words, phrases, or sentences — supports Hindi, English, and mixed Hindi-English speech.",
  sensitivity: "Sensitivity",
  transcriptSimilarity: "Transcript similarity",
  audioSimilarity: "Audio similarity",
  maxGap: "Max gap between repeats",
  minSegmentDuration: "Min segment duration",
  confidenceThreshold: "Confidence threshold",
  scanSelectedClip: "Scan Selected Clip",
  scanSelectedClipHint: "Scan the selected clip",
  selectClipFirst: "Select a clip on the timeline first",
  scanEntireTimeline: "Scan Entire Timeline",
  pause: "Pause",
  cancel: "Cancel",
  paused: "Scan paused — already-processed audio won't be reprocessed when you resume.",
  resume: "Resume",
  scanFailed: "The scan failed.",
  tryAgain: "Try again",
  scanCancelled: "Scan cancelled.",
  back: "Back",
  toReview: (n) => `${n} to review`,
  corrected: (n) => `${n} corrected`,
  noRepetitions: "No repetitions detected.",
  newScan: "New scan",
  suggestionsTab: "Suggestions",
  scriptTab: "Script",
  correctAllHighConfidence: "Correct All High-Confidence Repetitions",
  keepOriginal: "Keep Original",
  removeDuplicate: "Remove Duplicate",
  replaceWithRoomTone: "Replace with Room Tone",
  trimAudioVideo: "Trim Audio & Video",
  playBefore: "Play Before",
  playAfter: "Play After",
  speaker: "Speaker",
  original: "Original",
  repeated: "Repetitive Part",
  correctedScript: "Corrected Script",
  undo: "Undo",
  edit: "Edit",
  save: "Save",
  cancelEdit: "Cancel",
  applyFix: "Apply Fix",
  applyCorrection: "Apply Correction",
  applyAllApproved: "Apply All Approved Corrections",
  reviewRequired: "Review Required",
  noRepetitionDetected: "No repetitive word, phrase, or sentence detected.",
  loadingTranscript: "Loading transcript…",
  noTranscript: "No transcript available for this scan.",
  readScript: "Read Script",
  correctScriptAction: "Correct Script",
  editHint: "Click a line to edit it. Edits are saved automatically and never overwrite the video until you apply a correction.",
  batchTitle: "Correct all high-confidence repetitions?",
  batchDetected: "Repetitions detected",
  batchSelected: "Selected for correction",
  batchDurationRemoved: "Duration removed/repaired",
  batchNeedsReview: (n) => `${n} additional result(s) need manual review and won't be touched by this action.`,
  batchConfirm: "Correct all",
  batchApplying: "Applying…",
  kindWord: "Repeated word",
  kindPhrase: "Repeated phrase",
  kindSentence: "Repeated sentence",
  kindClipOverlap: "Clip overlap",
  kindSceneJoin: "Scene-join duplicate",
  kindRenderDuplicate: "Duplicate audio",
  suggestTrim: "Suggested fix: cut this line out entirely (audio & video).",
  suggestRoomTone: "Suggested fix: replace this line's audio with room tone (video keeps playing).",
  stageQueued: "Waiting to start",
  stageExtracting: "Extracting audio",
  stageDetecting: "Detecting speech",
  stageTranscribing: "Transcribing dialogue",
  stageDiarizing: "Identifying speakers",
  stageComparing: "Comparing repeated segments",
  stagePreparing: "Preparing correction suggestions",
  stagePaused: "Paused",
  analysisLanguage: "Analysis language",
};

const hi: VoiceCorrectionStrings = {
  panelTitle: "एआई वॉइस करेक्शन",
  close: "बंद करें",
  intro: "टाइमलाइन में गलती से दोहराए गए शब्द, वाक्यांश या वाक्य खोजें — हिंदी, अंग्रेज़ी और मिश्रित हिंदी-अंग्रेज़ी बोली दोनों के लिए काम करता है।",
  sensitivity: "संवेदनशीलता",
  transcriptSimilarity: "टेक्स्ट समानता",
  audioSimilarity: "ऑडियो समानता",
  maxGap: "दोहराव के बीच अधिकतम अंतराल",
  minSegmentDuration: "न्यूनतम खंड अवधि",
  confidenceThreshold: "विश्वास सीमा",
  scanSelectedClip: "चयनित क्लिप स्कैन करें",
  scanSelectedClipHint: "चयनित क्लिप स्कैन करें",
  selectClipFirst: "पहले टाइमलाइन पर एक क्लिप चुनें",
  scanEntireTimeline: "पूरी टाइमलाइन स्कैन करें",
  pause: "रोकें",
  cancel: "रद्द करें",
  paused: "स्कैन रोका गया — पहले से प्रोसेस किया गया ऑडियो फिर से प्रोसेस नहीं होगा।",
  resume: "फिर से शुरू करें",
  scanFailed: "स्कैन विफल हो गया।",
  tryAgain: "फिर कोशिश करें",
  scanCancelled: "स्कैन रद्द कर दिया गया।",
  back: "वापस",
  toReview: (n) => `${n} समीक्षा के लिए`,
  corrected: (n) => `${n} सही किए गए`,
  noRepetitions: "कोई दोहराव नहीं मिला।",
  newScan: "नया स्कैन",
  suggestionsTab: "सुझाव",
  scriptTab: "स्क्रिप्ट",
  correctAllHighConfidence: "सभी उच्च-विश्वास दोहराव ठीक करें",
  keepOriginal: "मूल रखें",
  removeDuplicate: "डुप्लिकेट हटाएँ",
  replaceWithRoomTone: "रूम टोन से बदलें",
  trimAudioVideo: "ऑडियो और वीडियो ट्रिम करें",
  playBefore: "पहले सुनें",
  playAfter: "बाद में सुनें",
  speaker: "वक्ता",
  original: "मूल",
  repeated: "दोहराया गया भाग",
  correctedScript: "सही की गई स्क्रिप्ट",
  undo: "पूर्ववत करें",
  edit: "संपादित करें",
  save: "सहेजें",
  cancelEdit: "रद्द करें",
  applyFix: "सुधार लागू करें",
  applyCorrection: "सुधार लागू करें",
  applyAllApproved: "सभी स्वीकृत सुधार लागू करें",
  reviewRequired: "समीक्षा आवश्यक",
  noRepetitionDetected: "कोई दोहराया गया शब्द, वाक्यांश या वाक्य नहीं मिला।",
  loadingTranscript: "स्क्रिप्ट लोड हो रही है…",
  noTranscript: "इस स्कैन के लिए कोई स्क्रिप्ट उपलब्ध नहीं है।",
  readScript: "स्क्रिप्ट पढ़ें",
  correctScriptAction: "स्क्रिप्ट सही करें",
  editHint: "किसी पंक्ति को संपादित करने के लिए उस पर क्लिक करें। परिवर्तन अपने आप सहेजे जाते हैं और जब तक आप सुधार लागू नहीं करते, वीडियो नहीं बदलेगा।",
  batchTitle: "सभी उच्च-विश्वास दोहराव ठीक करें?",
  batchDetected: "पाए गए दोहराव",
  batchSelected: "सुधार के लिए चुने गए",
  batchDurationRemoved: "हटाई/ठीक की गई अवधि",
  batchNeedsReview: (n) => `${n} अतिरिक्त परिणाम(परिणामों) को मैन्युअल समीक्षा की आवश्यकता है और यह क्रिया उन्हें प्रभावित नहीं करेगी।`,
  batchConfirm: "सभी ठीक करें",
  batchApplying: "लागू हो रहा है…",
  kindWord: "दोहराया गया शब्द",
  kindPhrase: "दोहराया गया वाक्यांश",
  kindSentence: "दोहराया गया वाक्य",
  kindClipOverlap: "क्लिप ओवरलैप",
  kindSceneJoin: "सीन-जोड़ डुप्लिकेट",
  kindRenderDuplicate: "डुप्लिकेट ऑडियो",
  suggestTrim: "सुझाया गया सुधार: इस पंक्ति को पूरी तरह हटाएँ (ऑडियो और वीडियो दोनों)।",
  suggestRoomTone: "सुझाया गया सुधार: इस पंक्ति के ऑडियो को रूम टोन से बदलें (वीडियो चलता रहेगा)।",
  stageQueued: "शुरू होने की प्रतीक्षा में",
  stageExtracting: "ऑडियो निकाला जा रहा है",
  stageDetecting: "बोली का पता लगाया जा रहा है",
  stageTranscribing: "संवाद ट्रांसक्राइब हो रहा है",
  stageDiarizing: "वक्ताओं की पहचान हो रही है",
  stageComparing: "दोहराए गए खंडों की तुलना हो रही है",
  stagePreparing: "सुधार सुझाव तैयार हो रहे हैं",
  stagePaused: "रुका हुआ",
  analysisLanguage: "विश्लेषण भाषा",
};

export const VOICE_CORRECTION_STRINGS: Record<DisplayLang, VoiceCorrectionStrings> = { en, hi };

export const LANGUAGE_LABELS: Record<DisplayLang, string> = { en: "English", hi: "हिंदी" };
