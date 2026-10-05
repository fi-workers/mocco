"""Build the OG cards' Hanja and kana fallback fonts (docs/reference/og-images.md).

Instances Noto Sans CJK KR's variable OTF at the two weights the templates use (400, 600),
keeps only kana, CJK punctuation, full-width forms and the ideographs of KS X 1001 and
JIS X 0208, and converts the CFF2 outlines to CFF, which satori's font parser reads.

Needs fontTools (`pip install fonttools`). Source: Sans/Variable/OTF/NotoSansCJKkr-VF.otf
from github.com/notofonts/noto-cjk at tag Sans2.004 (sha256 828d8415...059e8).

    python3 scripts/og-assets/build-cjk-fonts.py NotoSansCJKkr-VF.otf packages/backend/src/domain/og/fonts
"""

import io
import os
import sys

from fontTools import subset
from fontTools.cffLib.CFF2ToCFF import convertCFF2ToCFF
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

WEIGHTS = ((400, 'Regular'), (600, 'SemiBold'))


def is_ideograph(cp):
    return 0x3400 <= cp <= 0x4DBF or 0x4E00 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF


def legacy_charset_ideographs():
    """Every ideograph Korean (KS X 1001, via EUC-KR) and Japanese (JIS X 0208, via EUC-JP) encode."""
    found = set()
    for codec in ('euc_kr', 'euc_jp'):
        for lead in range(0xA1, 0xFF):
            for trail in range(0xA1, 0xFF):
                try:
                    char = bytes([lead, trail]).decode(codec)
                except UnicodeDecodeError:
                    continue
                if len(char) == 1 and is_ideograph(ord(char)):
                    found.add(ord(char))
    return found


def codepoints():
    kana = set(range(0x3040, 0x3100)) | set(range(0x31F0, 0x3200)) | set(range(0xFF65, 0xFFA0))
    punctuation = set(range(0x3000, 0x3040)) | set(range(0xFF01, 0xFF65))
    return sorted(kana | punctuation | legacy_charset_ideographs())


def main(source, out_dir):
    unicodes = codepoints()
    for weight, style in WEIGHTS:
        font = instantiateVariableFont(TTFont(source), {'wght': weight}, updateFontNames=False)
        options = subset.Options()
        options.layout_features = ['*']
        options.name_IDs = ['*']
        options.notdef_outline = True
        options.hinting = False
        # Cards lay text out horizontally; the vertical metrics and baseline tables go.
        options.drop_tables += ['vhea', 'vmtx', 'VORG', 'VVAR', 'BASE', 'STAT']
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        # Round-trip the static CFF2 font and rewrite its outlines as CFF the way fontTools'
        # own CFF2ToCFF command does: bounding boxes kept, not recalculated by glyph name.
        buffer = io.BytesIO()
        font.save(buffer)
        buffer.seek(0)
        font = TTFont(buffer, recalcBBoxes=False)
        convertCFF2ToCFF(font)
        out = os.path.join(out_dir, f'NotoSansCJKkr-{style}.otf')
        font.save(out)
        print(out, len(unicodes), 'codepoints', os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
