"""
Markdown-to-speech preprocessor.

Converts markdown formatting into natural-sounding plain text suitable
for TTS synthesis. Strips or transforms:
  - Headers → sentence with pause
  - Bold/italic → plain text
  - Lists → natural enumeration
  - Links → just the link text
  - Code blocks → "code block" or skip
  - Blockquotes → "Quote: ..."
  - Horizontal rules → pause
  - Footnote markers ([1], [^2]) → removed silently
  - References/Bibliography sections → dropped entirely
"""

import re

# Header text that signals the start of a references/bibliography section.
# Everything from this header onward is dropped.
_REFERENCES_HEADERS = re.compile(
    r"^#{1,6}\s+(references|bibliography|citations|sources|footnotes|notes|works\s+cited|further\s+reading|see\s+also)\s*$",
    re.IGNORECASE,
)


def preprocess_for_speech(text: str) -> str:
    """Convert markdown text to natural speech-friendly plain text."""
    lines = text.split("\n")
    result_lines: list[str] = []
    in_code_block = False
    in_references = False
    list_counters: dict[int, int] = {}  # indent level -> counter

    for line in lines:
        # Once we hit a references section, drop everything that follows
        if in_references:
            continue

        # Toggle code blocks
        if line.strip().startswith("```"):
            if not in_code_block:
                result_lines.append("Code block.")
            in_code_block = not in_code_block
            continue

        # Skip code block contents
        if in_code_block:
            continue

        # Horizontal rules
        if re.match(r"^[\s]*[-*_]{3,}[\s]*$", line):
            result_lines.append("")
            continue

        # Headers: check for references section first, then emit as speech
        header_match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if header_match:
            header_text = header_match.group(2).strip()
            if _REFERENCES_HEADERS.match(line):
                in_references = True
                continue
            header_text = _clean_inline_formatting(header_text)
            result_lines.append(f"{header_text}.")
            continue

        # Footnote definitions: [^1]: ... or [1]: ... — skip entirely
        if re.match(r"^\s*\[\^?\d+\]:", line):
            continue

        # Blockquotes: > text → "Quote: text"
        quote_match = re.match(r"^>\s*(.*)$", line)
        if quote_match:
            quote_text = quote_match.group(1).strip()
            if quote_text:
                quote_text = _clean_inline_formatting(quote_text)
                result_lines.append(f"Quote: {quote_text}")
            continue

        # Unordered lists: - item, * item, + item
        ul_match = re.match(r"^(\s*)[-*+]\s+(.+)$", line)
        if ul_match:
            indent = len(ul_match.group(1))
            item_text = _clean_inline_formatting(ul_match.group(2).strip())
            # Reset counters for this indent level
            list_counters[indent] = 0
            result_lines.append(item_text)
            continue

        # Ordered lists: 1. item, 2) item
        ol_match = re.match(r"^(\s*)\d+[.)]\s+(.+)$", line)
        if ol_match:
            indent = len(ol_match.group(1))
            item_text = _clean_inline_formatting(ol_match.group(2).strip())
            # Track position for natural enumeration
            list_counters[indent] = list_counters.get(indent, 0) + 1
            ordinal = _ordinal(list_counters[indent])
            result_lines.append(f"{ordinal}, {item_text}")
            continue

        # Regular paragraph
        cleaned = _clean_inline_formatting(line)
        if cleaned.strip():
            result_lines.append(cleaned)
        elif result_lines and result_lines[-1]:
            # Preserve paragraph breaks
            result_lines.append("")

    # Join and clean up multiple blank lines
    text = "\n".join(result_lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _clean_inline_formatting(text: str) -> str:
    """Remove inline markdown formatting."""
    # Footnote references: [1], [^1], [42], [^42] — strip silently
    text = re.sub(r"\[\^?\d+\]", "", text)

    # Images: ![alt](url) → alt text or skip
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)

    # Links: [text](url) → text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)

    # Bold + italic: ***text*** or ___text___
    text = re.sub(r"[*_]{3}([^*_]+)[*_]{3}", r"\1", text)

    # Bold: **text** or __text__
    text = re.sub(r"[*_]{2}([^*_]+)[*_]{2}", r"\1", text)

    # Italic: *text* or _text_
    text = re.sub(r"[*_]([^*_]+)[*_]", r"\1", text)

    # Strikethrough: ~~text~~
    text = re.sub(r"~~([^~]+)~~", r"\1", text)

    # Inline code: `code`
    text = re.sub(r"`([^`]+)`", r"\1", text)

    # HTML tags
    text = re.sub(r"<[^>]+>", "", text)

    # Escape sequences
    text = text.replace("\\*", "*")
    text = text.replace("\\_", "_")
    text = text.replace("\\#", "#")
    text = text.replace("\\[", "[")
    text = text.replace("\\]", "]")

    return text


def _ordinal(n: int) -> str:
    """Convert number to spoken ordinal: 1 → 'First', 2 → 'Second', etc."""
    ordinals = {
        1: "First",
        2: "Second",
        3: "Third",
        4: "Fourth",
        5: "Fifth",
        6: "Sixth",
        7: "Seventh",
        8: "Eighth",
        9: "Ninth",
        10: "Tenth",
    }
    if n in ordinals:
        return ordinals[n]
    # Fallback for larger numbers
    if n % 10 == 1 and n != 11:
        return f"{n}st"
    elif n % 10 == 2 and n != 12:
        return f"{n}nd"
    elif n % 10 == 3 and n != 13:
        return f"{n}rd"
    else:
        return f"{n}th"
