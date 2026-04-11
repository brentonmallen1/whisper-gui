"""
Available Kokoro TTS voices (English only).

Voice IDs follow the pattern: {region}{gender}_{name}
  af_ = American Female
  am_ = American Male
  bf_ = British Female
  bm_ = British Male
"""

VOICES: dict[str, dict] = {
    # American Female
    "af_alloy":   {"name": "Alloy",   "gender": "female", "accent": "american"},
    "af_aoede":   {"name": "Aoede",   "gender": "female", "accent": "american"},
    "af_bella":   {"name": "Bella",   "gender": "female", "accent": "american"},
    "af_heart":   {"name": "Heart",   "gender": "female", "accent": "american"},
    "af_jessica": {"name": "Jessica", "gender": "female", "accent": "american"},
    "af_kore":    {"name": "Kore",    "gender": "female", "accent": "american"},
    "af_nicole":  {"name": "Nicole",  "gender": "female", "accent": "american"},
    "af_nova":    {"name": "Nova",    "gender": "female", "accent": "american"},
    "af_river":   {"name": "River",   "gender": "female", "accent": "american"},
    "af_sarah":   {"name": "Sarah",   "gender": "female", "accent": "american"},
    "af_sky":     {"name": "Sky",     "gender": "female", "accent": "american"},
    # American Male
    "am_adam":    {"name": "Adam",    "gender": "male",   "accent": "american"},
    "am_echo":    {"name": "Echo",    "gender": "male",   "accent": "american"},
    "am_eric":    {"name": "Eric",    "gender": "male",   "accent": "american"},
    "am_fenrir":  {"name": "Fenrir",  "gender": "male",   "accent": "american"},
    "am_liam":    {"name": "Liam",    "gender": "male",   "accent": "american"},
    "am_michael": {"name": "Michael", "gender": "male",   "accent": "american"},
    "am_onyx":    {"name": "Onyx",    "gender": "male",   "accent": "american"},
    "am_puck":    {"name": "Puck",    "gender": "male",   "accent": "american"},
    "am_santa":   {"name": "Santa",   "gender": "male",   "accent": "american"},
    # British Female
    "bf_alice":     {"name": "Alice",     "gender": "female", "accent": "british"},
    "bf_emma":      {"name": "Emma",      "gender": "female", "accent": "british"},
    "bf_isabella":  {"name": "Isabella",  "gender": "female", "accent": "british"},
    "bf_lily":      {"name": "Lily",      "gender": "female", "accent": "british"},
    # British Male
    "bm_daniel":  {"name": "Daniel",  "gender": "male",   "accent": "british"},
    "bm_fable":   {"name": "Fable",   "gender": "male",   "accent": "british"},
    "bm_george":  {"name": "George",  "gender": "male",   "accent": "british"},
    "bm_lewis":   {"name": "Lewis",   "gender": "male",   "accent": "british"},
}

DEFAULT_VOICE = "af_bella"
