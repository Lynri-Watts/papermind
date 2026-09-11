from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn, nsmap
from lxml import etree
import copy

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

# Color palette - enhanced contrast
BG_DARK = RGBColor(0x0A, 0x12, 0x20)  # Darker for better contrast
BG_CARD = RGBColor(0x1A, 0x26, 0x3A)  # Slightly lighter card bg
PRIMARY = RGBColor(0x7C, 0x7F, 0xF5)  # Brighter Indigo for visibility
ACCENT = RGBColor(0x2D, 0xE8, 0xF5)   # Brighter Cyan
SUCCESS = RGBColor(0x3F, 0xE0, 0xA8)  # Brighter Green
WARNING = RGBColor(0xFC, 0xA3, 0x4E)  # Brighter Orange
DANGER = RGBColor(0xFA, 0x85, 0x85)   # Brighter Red
TEXT_PRIMARY = RGBColor(0xFA, 0xFA, 0xFA)  # Near-white for max contrast
TEXT_SECONDARY = RGBColor(0xB8, 0xC5, 0xD0)  # Lighter secondary for readability
BORDER = RGBColor(0x40, 0x50, 0x65)  # More visible border


def set_slide_bg(slide, color):
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = color


def add_text_box(slide, left, top, width, height, text, font_size=18, bold=False, color=TEXT_PRIMARY, alignment=PP_ALIGN.LEFT):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(font_size)
    p.font.bold = bold
    p.font.color.rgb = color
    p.alignment = alignment
    return txBox


def add_rounded_rect(slide, left, top, width, height, fill_color=BG_CARD, border_color=BORDER):
    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    shape.line.color.rgb = border_color
    shape.line.width = Pt(1)
    return shape


def add_bullet_list(slide, left, top, width, height, items, font_size=16, color=TEXT_PRIMARY):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    
    for i, item in enumerate(items):
        if i == 0:
            p = tf.paragraphs[0]
        else:
            p = tf.add_paragraph()
        
        p.text = item
        p.font.size = Pt(font_size)
        p.font.color.rgb = color
        p.space_after = Pt(12)
        p.level = 0
    
    return txBox


def add_card_with_title(slide, left, top, width, height, title, content_lines, accent_color=PRIMARY):
    card = add_rounded_rect(slide, left, top, width, height)
    
    accent_bar = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, left + Inches(0.15), top + Inches(0.15), Inches(0.08), Inches(0.6)
    )
    accent_bar.fill.solid()
    accent_bar.fill.fore_color.rgb = accent_color
    accent_bar.line.fill.background()
    
    add_text_box(slide, left + Inches(0.4), top + Inches(0.15), width - Inches(0.6), Inches(0.5),
                 title, font_size=18, bold=True, color=TEXT_PRIMARY)
    
    content_text = "\n".join(content_lines)
    add_text_box(slide, left + Inches(0.4), top + Inches(0.75), width - Inches(0.6), height - Inches(0.9),
                 content_text, font_size=14, color=TEXT_SECONDARY)
    
    return card


def add_fade_animation(slide, shape, delay_ms=0, duration_ms=500):
    """Add fade-in animation to a shape"""
    shape_id = shape.shape_id
    
    # Get or create timing element
    sp_tree = slide.shapes._spTree
    slide_element = sp_tree.getparent()
    
    # Find or create timing element
    timing = slide_element.find(qn('p:timing'))
    if timing is None:
        timing = etree.SubElement(slide_element, qn('p:timing'))
    
    tn_lst = timing.find(qn('p:tnLst'))
    if tn_lst is None:
        tn_lst = etree.SubElement(timing, qn('p:tnLst'))
    
    par = tn_lst.find(qn('p:par'))
    if par is None:
        par = etree.SubElement(tn_lst, qn('p:par'))
        cTn = etree.SubElement(par, qn('p:cTn'), attrib={'id': '1', 'dur': 'indefinite', 'restart': 'never', 'nodeType': 'tmRoot'})
        child_tn_lst = etree.SubElement(cTn, qn('p:childTnLst'))
        seq = etree.SubElement(child_tn_lst, qn('p:seq'), attrib={'concurrent': '1', 'nextAc': 'seek'})
        seq_cTn = etree.SubElement(seq, qn('p:cTn'), attrib={'id': '2', 'dur': 'indefinite', 'nodeType': 'mainSeq'})
        seq_child_tn_lst = etree.SubElement(seq_cTn, qn('p:childTnLst'))
    else:
        cTn = par.find(qn('p:cTn'))
        if cTn is None:
            return
        child_tn_lst = cTn.find(qn('p:childTnLst'))
        if child_tn_lst is None:
            return
        seq = child_tn_lst.find(qn('p:seq'))
        if seq is None:
            return
        seq_cTn = seq.find(qn('p:cTn'))
        if seq_cTn is None:
            return
        seq_child_tn_lst = seq_cTn.find(qn('p:childTnLst'))
        if seq_child_tn_lst is None:
            seq_child_tn_lst = etree.SubElement(seq_cTn, qn('p:childTnLst'))
    
    # Count existing animations
    existing = len(seq_child_tn_lst.findall(qn('p:par')))
    anim_id = 3 + existing * 4
    
    # Add fade animation
    anim_par = etree.SubElement(seq_child_tn_lst, qn('p:par'))
    anim_cTn = etree.SubElement(anim_par, qn('p:cTn'), attrib={'id': str(anim_id), 'fill': 'hold'})
    
    stCondLst = etree.SubElement(anim_cTn, qn('p:stCondLst'))
    cond = etree.SubElement(stCondLst, qn('p:cond'), attrib={'delay': str(delay_ms)})
    
    anim_child_tn_lst = etree.SubElement(anim_cTn, qn('p:childTnLst'))
    anim_par2 = etree.SubElement(anim_child_tn_lst, qn('p:par'))
    anim_cTn2 = etree.SubElement(anim_par2, qn('p:cTn'), attrib={'id': str(anim_id + 1), 'presetID': '10', 'presetClass': 'entr', 'presetSubtype': '0', 'fill': 'hold', 'nodeType': 'clickEffect'})
    
    anim_stCondLst = etree.SubElement(anim_cTn2, qn('p:stCondLst'))
    anim_cond = etree.SubElement(anim_stCondLst, qn('p:cond'), attrib={'delay': '0'})
    
    anim_child_tn_lst2 = etree.SubElement(anim_cTn2, qn('p:childTnLst'))
    
    # Set animation
    set_elem = etree.SubElement(anim_child_tn_lst2, qn('p:set'))
    set_cBhvr = etree.SubElement(set_elem, qn('p:cBhvr'))
    set_cTn = etree.SubElement(set_cBhvr, qn('p:cTn'), attrib={'id': str(anim_id + 2), 'dur': '1', 'fill': 'hold'})
    set_stCondLst = etree.SubElement(set_cTn, qn('p:stCondLst'))
    set_cond = etree.SubElement(set_stCondLst, qn('p:cond'), attrib={'delay': '0'})
    set_tgtEl = etree.SubElement(set_cBhvr, qn('p:tgtEl'))
    set_spTgt = etree.SubElement(set_tgtEl, qn('p:spTgt'), attrib={'spid': str(shape_id)})
    set_attrNameLst = etree.SubElement(set_cBhvr, qn('p:attrNameLst'))
    set_attrName = etree.SubElement(set_attrNameLst, qn('p:attrName'))
    set_attrName.text = 'style.visibility'
    set_to = etree.SubElement(set_elem, qn('p:to'), attrib={'val': 'visible'})
    
    # Animate effect
    anim_effect = etree.SubElement(anim_child_tn_lst2, qn('p:animEffect'), attrib={'transition': 'in', 'filter': 'fade'})
    anim_effect_cBhvr = etree.SubElement(anim_effect, qn('p:cBhvr'))
    anim_effect_cTn = etree.SubElement(anim_effect_cBhvr, qn('p:cTn'), attrib={'id': str(anim_id + 3), 'dur': str(duration_ms)})
    anim_effect_tgtEl = etree.SubElement(anim_effect_cBhvr, qn('p:tgtEl'))
    anim_effect_spTgt = etree.SubElement(anim_effect_tgtEl, qn('p:spTgt'), attrib={'spid': str(shape_id)})


def add_appear_animation_to_shapes(slide, shapes_list, delay_between=200):
    """Add appear animation to multiple shapes with staggered timing"""
    for i, shape in enumerate(shapes_list):
        add_fade_animation(slide, shape, delay_ms=i * delay_between)


# ========== Slide 1: Title Slide ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

# Decorative elements
circle1 = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(-2), Inches(-2), Inches(6), Inches(6))
circle1.fill.solid()
circle1.fill.fore_color.rgb = RGBColor(0x1E, 0x29, 0x3B)
circle1.line.fill.background()

circle2 = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(10), Inches(4), Inches(5), Inches(5))
circle2.fill.solid()
circle2.fill.fore_color.rgb = RGBColor(0x1E, 0x29, 0x3B)
circle2.line.fill.background()

# Title
add_text_box(slide, Inches(1), Inches(2.2), Inches(11), Inches(1.2),
             "PaperMind", font_size=64, bold=True, color=TEXT_PRIMARY)

# Subtitle with gradient effect
add_text_box(slide, Inches(1), Inches(3.4), Inches(11), Inches(0.8),
             "Browser-Native AI Research Co-Pilot", font_size=28, bold=False, color=ACCENT)

# Tagline
add_text_box(slide, Inches(1), Inches(4.5), Inches(11), Inches(0.6),
             "Drowning in information, starving for knowledge.", font_size=20, bold=False, color=TEXT_SECONDARY, alignment=PP_ALIGN.LEFT)

# Team info
add_text_box(slide, Inches(1), Inches(6.2), Inches(11), Inches(0.5),
             "2026 Product Demo", font_size=16, color=TEXT_SECONDARY)


# ========== Slide 2: The Problem ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "The Problem: Information Overload", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "We have more papers than ever — but less actual knowledge.", font_size=18, color=TEXT_SECONDARY)

# Three stat cards
card_width = Inches(3.8)
card_height = Inches(2.5)
y_pos = Inches(2.3)

# Stat 1
add_card_with_title(slide, Inches(0.8), y_pos, card_width, card_height,
                    "3M+ Papers / Year",
                    ["One new paper every 10 seconds",
                     "Researchers can read < 1% of relevant literature",
                     "Information overwhelm = slow progress"],
                    accent_color=DANGER)

# Stat 2
add_card_with_title(slide, Inches(4.8), y_pos, card_width, card_height,
                    "AI Hallucination Risk",
                    ["Up to 30% fake citations in academic AI outputs",
                     "Chasing ghost references wastes hours",
                     "Verification is a new form of labor"],
                    accent_color=WARNING)

# Stat 3
add_card_with_title(slide, Inches(8.8), y_pos, card_width, card_height,
                    "Fragmented Workflow",
                    ["10+ tabs open per research session",
                     "Copy-paste between tools is error-prone",
                     "Knowledge gets lost in silos"],
                    accent_color=PRIMARY)

# Bottom quote
quote_box = add_rounded_rect(slide, Inches(0.8), Inches(5.3), Inches(11.8), Inches(1.5))
add_text_box(slide, Inches(1.2), Inches(5.5), Inches(11), Inches(1),
             "\"Drowning in information, starving for knowledge.\"",
             font_size=22, bold=True, color=ACCENT, alignment=PP_ALIGN.CENTER)


# ========== Slide 3: Current Tools Are Broken ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Today's Tools Treat Research Like a Vending Machine", font_size=32, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "Insert question → receive answer. No collaboration, no memory, no verification.", font_size=18, color=TEXT_SECONDARY)

# Vending machine analogy
left_col = Inches(0.8)
right_col = Inches(6.8)
col_width = Inches(5.8)
card_h = Inches(4.8)

# Left: Current approach
add_card_with_title(slide, left_col, Inches(2.2), col_width, card_h,
                    "Current: Q&A Pipeline",
                    ["",
                     "  🔴  One-way: Question → Answer",
                     "  🔴  No context of your work",
                     "  🔴  Answers need manual verification",
                     "  🔴  No memory across sessions",
                     "  🔴  Works in isolation, not with you",
                     "",
                     "Tools: ChatGPT, Gemini, Elicit, Scite"],
                    accent_color=DANGER)

# Right: Our approach
add_card_with_title(slide, right_col, Inches(2.2), col_width, card_h,
                    "PaperMind: Co-Pilot Loop",
                    ["",
                     "  🟢  Observe → Understand → Suggest → Verify",
                     "  🟢  Lives in your browser, knows your research",
                     "  🟢  Every claim bound to real source pages",
                     "  🟢  Builds your knowledge graph over time",
                     "  🟢  Works alongside you, not for you",
                     "",
                     "Philosophy: AI should amplify thinking, not replace it"],
                    accent_color=SUCCESS)

# Tagline at bottom
add_text_box(slide, Inches(0.8), Inches(6.7), Inches(12), Inches(0.6),
             "Not a vending machine for answers — a co-pilot for discovery.",
             font_size=20, bold=True, color=ACCENT, alignment=PP_ALIGN.CENTER)


# ========== Slide 4: Product Overview ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Introducing PaperMind", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "The world's first browser-native AI research co-pilot.", font_size=18, color=TEXT_SECONDARY)

# Four core modules
modules = [
    ("Deep Research", "RAG-powered reading\nassistant + Q&A", "📚", PRIMARY),
    ("Explore", "Knowledge graph + paper\nsearch & discovery", "🔍", ACCENT),
    ("Workspace", "LaTeX editor + AI\nwriting assistance", "✍️", SUCCESS),
    ("Context Manager", "Add papers, URLs,\nMCP skills to RAG", "🧩", WARNING),
]

mod_width = Inches(2.8)
mod_height = Inches(3.2)
mod_y = Inches(2.3)
spacing = Inches(0.267)

for i, (title, desc, icon, color) in enumerate(modules):
    x = Inches(0.8) + i * (mod_width + spacing)
    
    card = add_rounded_rect(slide, x, mod_y, mod_width, mod_height)
    
    # Icon
    add_text_box(slide, x, mod_y + Inches(0.3), mod_width, Inches(0.8),
                 icon, font_size=36, alignment=PP_ALIGN.CENTER)
    
    # Title
    add_text_box(slide, x + Inches(0.2), mod_y + Inches(1.2), mod_width - Inches(0.4), Inches(0.5),
                 title, font_size=18, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)
    
    # Description
    add_text_box(slide, x + Inches(0.2), mod_y + Inches(1.8), mod_width - Inches(0.4), Inches(1.2),
                 desc, font_size=14, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)

# Bottom features
features_box = add_rounded_rect(slide, Inches(0.8), Inches(5.8), Inches(11.8), Inches(1.2))

features = [
    "🌐 Browser-Native — works where you read",
    "🔗 Fully Traceable — every claim has a source link",
    "👥 Team-Ready — built-in collaboration",
    "🧠 Context-Aware — understands your research direction",
]

for i, feat in enumerate(features):
    x = Inches(1) + i * Inches(3)
    add_text_box(slide, x, Inches(6.1), Inches(2.8), Inches(0.6),
                 feat, font_size=14, color=TEXT_PRIMARY)


# ========== Slide 5: Demo - Opening Transition ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(2.8), Inches(12), Inches(1),
             "Demo: PaperMind in Action", font_size=48, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)

add_text_box(slide, Inches(0.8), Inches(4), Inches(12), Inches(0.8),
             "We talked about the philosophy — now let me show you what it actually looks like.",
             font_size=22, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)

tagline_box = add_rounded_rect(slide, Inches(3), Inches(5.2), Inches(7.3), Inches(0.8))
add_text_box(slide, Inches(3.2), Inches(5.4), Inches(7), Inches(0.5),
             "Not a vending machine for answers — a co-pilot for discovery.",
             font_size=18, bold=True, color=ACCENT, alignment=PP_ALIGN.CENTER)


# ========== Slide 6: Demo - Three Core Modules ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "One Workspace. Three Modules. Full Research Journey.", font_size=32, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "Research is a journey: you search, you read, you connect ideas, you write.", font_size=18, color=TEXT_SECONDARY)

# Three module cards in order of research workflow
demo_modules = [
    ("Explore", "Discover papers & map the research landscape",
     ["Search papers by keyword", "Interactive knowledge graph", "Click any node → see connections", "One-click 'Read Paper' → seamless transition"],
     ACCENT, "🔍"),
    ("Deep Research", "Read with AI that reads the same paper as you",
     ["RAG-powered Q&A inline", "Context tab: build knowledge base", "Data Blocks: extract tables & charts", "'Add to Paper' → auto-generate LaTeX"],
     PRIMARY, "📚"),
    ("Workspace", "Write with AI that amplifies — never replaces — your judgment",
     ["3-panel layout: assistant, editor, preview", "AI suggestions inline in LaTeX", "Every citation bound to real source", "You're always in control"],
     SUCCESS, "✍️"),
]

mod_w = Inches(3.85)
mod_h = Inches(4.2)
mod_y = Inches(2.1)
spacing = Inches(0.2)

shapes_to_animate = []

for i, (title, subtitle, points, color, icon) in enumerate(demo_modules):
    x = Inches(0.8) + i * (mod_w + spacing)
    
    card = add_rounded_rect(slide, x, mod_y, mod_w, mod_h)
    shapes_to_animate.append(card)
    
    # Icon
    icon_box = add_text_box(slide, x, mod_y + Inches(0.2), mod_w, Inches(0.6),
                            icon, font_size=32, alignment=PP_ALIGN.CENTER)
    shapes_to_animate.append(icon_box)
    
    # Title
    add_text_box(slide, x + Inches(0.2), mod_y + Inches(0.85), mod_w - Inches(0.4), Inches(0.4),
                 title, font_size=20, bold=True, color=color, alignment=PP_ALIGN.CENTER)
    
    # Subtitle
    add_text_box(slide, x + Inches(0.2), mod_y + Inches(1.3), mod_w - Inches(0.4), Inches(0.5),
                 subtitle, font_size=13, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)
    
    # Points
    points_text = "\n".join(["• " + p for p in points])
    add_text_box(slide, x + Inches(0.25), mod_y + Inches(1.9), mod_w - Inches(0.5), Inches(2.2),
                 points_text, font_size=13, color=TEXT_PRIMARY)

# Bottom flow arrow
flow_box = add_rounded_rect(slide, Inches(3.5), Inches(6.5), Inches(6.3), Inches(0.6))
add_text_box(slide, Inches(3.7), Inches(6.6), Inches(6), Inches(0.4),
             "Explore → Understand → Create — one seamless loop",
             font_size=16, bold=True, color=ACCENT, alignment=PP_ALIGN.CENTER)


# ========== Slide 7: Demo - Explore Module ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.5), Inches(12), Inches(0.7),
             "Explore: From List to Landscape", font_size=36, bold=True, color=ACCENT)

add_text_box(slide, Inches(0.8), Inches(1.15), Inches(12), Inches(0.4),
             "A list of papers is just another information dump. Researchers need the *structure* of a field.", font_size=16, color=TEXT_SECONDARY)

# Knowledge Graph concept
graph_box = add_rounded_rect(slide, Inches(0.8), Inches(1.8), Inches(6.2), Inches(4.8))
add_text_box(slide, Inches(1.1), Inches(2), Inches(5.6), Inches(0.5),
             "🎯 Knowledge Graph — The Centerpiece", font_size=18, bold=True, color=PRIMARY)

graph_points = [
    "Every node = entity (paper, author, topic)",
    "Colored lines = relationships (cites, authored, related)",
    "Zoom, pan, click to explore connections",
    "",
    "Example: Click 'Attention Is All You Need'",
    "→ See its intellectual lineage instantly:",
    "   BERT built on it, GPT-3 built on it, ViT built on it",
    "",
    "One paper → entire field structure visible"
]
add_text_box(slide, Inches(1.1), Inches(2.6), Inches(5.6), Inches(3.8),
             "\n".join(graph_points), font_size=14, color=TEXT_PRIMARY)

# Philosophy box
phil_box = add_rounded_rect(slide, Inches(7.2), Inches(1.8), Inches(5.4), Inches(2.8))
add_text_box(slide, Inches(7.5), Inches(2), Inches(4.8), Inches(0.5),
             "💡 Why This Matters", font_size=18, bold=True, color=WARNING)

phil_text = "AI shouldn't just give you answers —\nit should help you *see* the bigger picture.\n\nA search engine gives you a list.\nA knowledge graph gives you understanding.\n\nThat's the difference between being told\nwhat to think and being empowered to\nthink for yourself."
add_text_box(slide, Inches(7.5), Inches(2.55), Inches(4.8), Inches(2.1),
             phil_text, font_size=14, color=TEXT_PRIMARY)

# Seamless transition box
transition_box = add_rounded_rect(slide, Inches(7.2), Inches(4.9), Inches(5.4), Inches(1.7))
add_text_box(slide, Inches(7.5), Inches(5.1), Inches(4.8), Inches(0.4),
             "🔗 Seamless Transition", font_size=16, bold=True, color=SUCCESS)
add_text_box(slide, Inches(7.5), Inches(5.55), Inches(4.8), Inches(1),
             "Find a paper → Click 'Read Paper'\n→ Go straight to Deep Research mode\nNo new tab, no context switching",
             font_size=13, color=TEXT_PRIMARY)


# ========== Slide 8: Demo - Deep Research Module ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.5), Inches(12), Inches(0.7),
             "Deep Research: Read with an AI That Reads With You", font_size=32, bold=True, color=PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.15), Inches(12), Inches(0.4),
             "Every answer is grounded in the actual paper — RAG working in real time.", font_size=16, color=TEXT_SECONDARY)

# Layout diagram
layout_box = add_rounded_rect(slide, Inches(0.8), Inches(1.8), Inches(4.5), Inches(3.2))
add_text_box(slide, Inches(1.1), Inches(2), Inches(4), Inches(0.4),
             "📋 The Layout", font_size=16, bold=True, color=PRIMARY)
add_text_box(slide, Inches(1.1), Inches(2.5), Inches(4), Inches(2.4),
             "Left: The paper itself\n\nRight: Your AI research assistant\n\nTabs: Q&A | Context | Data Blocks\n\nNo separate chat window.\nNo copy-pasting back and forth.\nJust ask directly.",
             font_size=14, color=TEXT_PRIMARY)

# RAG explanation
rag_box = add_rounded_rect(slide, Inches(5.5), Inches(1.8), Inches(3.5), Inches(3.2))
add_text_box(slide, Inches(5.8), Inches(2), Inches(3), Inches(0.4),
             "⚡ RAG in Action", font_size=16, bold=True, color=ACCENT)
add_text_box(slide, Inches(5.8), Inches(2.5), Inches(3), Inches(2.4),
             "AI reads the paper alongside you.\n\nEverything it says traces back\nto specific passages.\n\nNot making things up from\ntraining data — grounded in\nthe actual document.",
             font_size=13, color=TEXT_PRIMARY)

# Key features
features_box = add_rounded_rect(slide, Inches(9.2), Inches(1.8), Inches(3.4), Inches(3.2))
add_text_box(slide, Inches(9.5), Inches(2), Inches(2.9), Inches(0.4),
             "🔑 Key Features", font_size=16, bold=True, color=SUCCESS)
add_text_box(slide, Inches(9.5), Inches(2.5), Inches(2.9), Inches(2.4),
             "Context Tab:\nBuild your research\nknowledge base\n\nData Blocks:\nExtract tables, charts\nAuto-generate LaTeX\n\n'Add to Paper':\nOne click → ready to use",
             font_size=13, color=TEXT_PRIMARY)

# Co-pilot philosophy
copilot_box = add_rounded_rect(slide, Inches(0.8), Inches(5.3), Inches(11.8), Inches(1.6))
add_text_box(slide, Inches(1.1), Inches(5.5), Inches(11), Inches(0.4),
             "🎯 'Co-Pilot, Not Vending Machine'", font_size=18, bold=True, color=WARNING)
add_text_box(slide, Inches(1.1), Inches(6), Inches(11), Inches(0.8),
             "A vending machine gives you a single answer in isolation. A co-pilot sits next to you, understands the full context of your work,\nand helps you move your research forward — from reading, to understanding, to actually producing something.",
             font_size=14, color=TEXT_PRIMARY)


# ========== Slide 9: Demo - Workspace Module ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.5), Inches(12), Inches(0.7),
             "Workspace: Write with AI That Amplifies Your Thinking", font_size=32, bold=True, color=SUCCESS)

add_text_box(slide, Inches(0.8), Inches(1.15), Inches(12), Inches(0.4),
             "The AI is not writing the paper for you — it's amplifying your thinking.", font_size=16, color=TEXT_SECONDARY)

# Three-panel layout
layout_title = add_text_box(slide, Inches(0.8), Inches(1.8), Inches(4), Inches(0.4),
                            "📐 Three-Panel Layout", font_size=16, bold=True, color=PRIMARY)

panels = [
    ("Left", "Reading Assistant", "Never lose source context"),
    ("Middle", "LaTeX Editor", "Write with AI inline"),
    ("Right", "Live Preview", "See your paper rendered"),
]

for i, (pos, name, desc) in enumerate(panels):
    x = Inches(0.8) + i * Inches(1.4)
    panel_box = add_rounded_rect(slide, x, Inches(2.3), Inches(1.3), Inches(1.5))
    add_text_box(slide, x + Inches(0.1), Inches(2.45), Inches(1.1), Inches(0.3),
                 pos, font_size=12, bold=True, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)
    add_text_box(slide, x + Inches(0.1), Inches(2.75), Inches(1.1), Inches(0.4),
                 name, font_size=13, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)
    add_text_box(slide, x + Inches(0.1), Inches(3.2), Inches(1.1), Inches(0.5),
                 desc, font_size=10, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)

# AI Edit feature
edit_box = add_rounded_rect(slide, Inches(5), Inches(2.3), Inches(4), Inches(1.5))
add_text_box(slide, Inches(5.3), Inches(2.5), Inches(3.5), Inches(0.4),
             "✨ AI Edit Feature", font_size=16, bold=True, color=ACCENT)
add_text_box(slide, Inches(5.3), Inches(2.95), Inches(3.5), Inches(0.8),
             "As you write, AI offers inline suggestions\nNot generic completion — context-aware\nHover: Accept, modify, or ignore\nYou're always in control",
             font_size=13, color=TEXT_PRIMARY)

# Citation binding
cite_box = add_rounded_rect(slide, Inches(9.2), Inches(2.3), Inches(3.4), Inches(1.5))
add_text_box(slide, Inches(9.5), Inches(2.5), Inches(2.9), Inches(0.4),
             "🔗 Citation Binding", font_size=16, bold=True, color=SUCCESS)
add_text_box(slide, Inches(9.5), Inches(2.95), Inches(2.9), Inches(0.8),
             "AI never invents citations\nEvery reference → real paper\nClick to verify source",
             font_size=13, color=TEXT_PRIMARY)

# Core principle box
principle_box = add_rounded_rect(slide, Inches(0.8), Inches(4.1), Inches(11.8), Inches(1.1))
add_text_box(slide, Inches(1.1), Inches(4.3), Inches(11), Inches(0.8),
             "Core Principle: AI shouldn't replace your judgment. It should make your judgment better-informed.\nEvery suggestion traces back to real papers in your context library.",
             font_size=15, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)

# Full loop summary
loop_box = add_rounded_rect(slide, Inches(0.8), Inches(5.5), Inches(11.8), Inches(1.4))
add_text_box(slide, Inches(1.1), Inches(5.7), Inches(11), Inches(0.4),
             "🔄 The Full Loop Working Together", font_size=16, bold=True, color=PRIMARY)
add_text_box(slide, Inches(1.1), Inches(6.15), Inches(11), Inches(0.6),
             "Explore to discover → Deep Research to understand → Workspace to create\nEach module flows into the next. Your knowledge compounds, not gets lost between tools.",
             font_size=14, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)


# ========== Slide 10: Demo - Philosophy in Action ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.5), Inches(12), Inches(0.7),
             "Philosophy in Action", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.2), Inches(12), Inches(0.4),
             "What we showed you connects directly to what we talked about earlier:", font_size=18, color=TEXT_SECONDARY)

# Three philosophy cards
philosophies = [
    ("AI should amplify thinking, not replace it",
     ["You don't ask 'write my literature review'",
      "You explore, read, build your understanding",
      "AI helps you work faster at every step",
      "You're in the driver's seat"],
     PRIMARY),
    ("Stop chasing ghosts, start discovering truths",
     ["Every claim traces back to a real source",
      "Every citation → verify in one click",
      "No ghost citations",
      "No wasted hours"],
     SUCCESS),
    ("From Q&A to collaboration, from static to seamless",
     ["Not a chat window you open occasionally",
      "A workspace you live in",
      "AI is there when you search, read, write",
      "Not a tool you use — a partner you work with"],
     ACCENT),
]

card_w = Inches(3.85)
card_h = Inches(3.5)
card_y = Inches(2)

for i, (title, points, color) in enumerate(philosophies):
    x = Inches(0.8) + i * (card_w + Inches(0.2))
    
    card = add_rounded_rect(slide, x, card_y, card_w, card_h)
    
    # Color bar at top
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, card_y, card_w, Inches(0.08))
    bar.fill.solid()
    bar.fill.fore_color.rgb = color
    bar.line.fill.background()
    
    add_text_box(slide, x + Inches(0.2), card_y + Inches(0.25), card_w - Inches(0.4), Inches(0.6),
                 title, font_size=15, bold=True, color=color, alignment=PP_ALIGN.CENTER)
    
    points_text = "\n".join(["• " + p for p in points])
    add_text_box(slide, x + Inches(0.25), card_y + Inches(0.95), card_w - Inches(0.5), Inches(2.4),
                 points_text, font_size=13, color=TEXT_PRIMARY)

# Transition to technology
trans_box = add_rounded_rect(slide, Inches(3), Inches(5.8), Inches(7.3), Inches(1))
add_text_box(slide, Inches(3.2), Inches(6), Inches(7), Inches(0.6),
             "Now you've seen what PaperMind does. Let's see how it works under the hood.",
             font_size=16, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)


# ========== Slide 11: Technology - 4 Core AI ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Four Core AI Technologies", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "AI is not an add-on — it's the entire skeleton and engine of the product.", font_size=18, color=TEXT_SECONDARY)

# 2x2 grid of tech cards
techs = [
    ("RAG — Retrieval-Augmented Generation",
     ["Reads PDFs & web pages, extracts paragraphs/charts/data",
      "Select any text → instant summary, translation, key points",
      "Root cause fix for hallucinations: all output bound to real sources"],
     PRIMARY,
     "Solves: Reading time + fake citations"),
    
    ("NLP — Semantic Understanding",
     ["Parses your research keywords and direction automatically",
      "Classifies reviews, experiments, methods papers intelligently",
      "Pushes frontier papers from arXiv, PubMed, Google Scholar"],
     ACCENT,
     "Solves: Search fatigue + irrelevant results"),
    
    ("Knowledge Graph (GNN + Entity Extraction)",
     ["Extracts models, datasets, conclusions, authors as entities",
      "Maps connections: A proposed B → C improved B → D used B",
      "Discovers hidden cross-field connections manual search misses"],
     SUCCESS,
     "Solves: Weak cross-paper connections"),
    
    ("Bidirectional Citation Tracking",
     ["Every AI output auto-binds to page numbers + source links",
      "Forward + backward citation tracing for full research lineage",
      "Multi-source cross-verification reduces hallucination risk"],
     WARNING,
     "Solves: Truth verification + citation audit"),
]

card_w = Inches(5.9)
card_h = Inches(2.4)

for i, (title, points, color, sub) in enumerate(techs):
    row = i // 2
    col = i % 2
    x = Inches(0.8) + col * (card_w + Inches(0.2))
    y = Inches(2.2) + row * (card_h + Inches(0.2))
    
    add_card_with_title(slide, x, y, card_w, card_h, title, points, accent_color=color)
    
    # Subtitle at bottom of card
    add_text_box(slide, x + Inches(0.4), y + card_h - Inches(0.45), card_w - Inches(0.6), Inches(0.35),
                 sub, font_size=12, bold=True, color=color)


# ========== Slide 6: Why AI is Core, Not Add-on ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "AI is the Product, Not a Feature", font_size=36, bold=True, color=TEXT_PRIMARY)

# Three layers
layers = [
    ("Layer 1: Core Functions Depend Entirely on AI",
     ["• Smart paper recommendation = NLP understanding",
      "• One-click PDF summary = RAG + LLM generation",
      "• Research lineage mapping = knowledge graph + GNN",
      "• Traceable citation output = bidirectional tracking algorithm",
      "Remove AI → product becomes a blank browser extension that just opens PDFs"]),
    
    ("Layer 2: Differentiation Comes From AI Integration",
     ["• Competitors: single Q&A AI, manual copy-paste workflow",
      "• Us: browser-native — NLP push + RAG read + graph weave + trace verify",
      "• Full-loop AI collaboration system is the moat, not individual features"]),
    
    ("Layer 3: Business Model & Growth Are Built on AI",
     ["• Freemium: basic AI free → advanced RAG/graph/tracing paid",
      "• Expandable: same RAG+NLP stack → patents, reports, legal docs",
      "• Scales with AI capability: better models = more value to users"]),
]

y = Inches(1.6)
for title, points in layers:
    card = add_rounded_rect(slide, Inches(0.8), y, Inches(11.8), Inches(1.65))
    
    add_text_box(slide, Inches(1.1), y + Inches(0.15), Inches(11), Inches(0.4),
                 title, font_size=18, bold=True, color=PRIMARY)
    
    add_text_box(slide, Inches(1.1), y + Inches(0.55), Inches(11), Inches(1.1),
                 "\n".join(points), font_size=14, color=TEXT_PRIMARY)
    
    y += Inches(1.8)


# ========== Slide 7: Competitive Landscape ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Competitive Landscape", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "From tools that manage files or answer questions → to a system that collaborates with you.", font_size=16, color=TEXT_SECONDARY)

# Comparison table-like structure
headers = ["Dimension", "Zotero / Mendeley", "Elicit / Scite", "PaperMind"]
col_widths = [Inches(2.5), Inches(3.2), Inches(3.2), Inches(3.7)]
x_positions = [Inches(0.8), Inches(3.3), Inches(6.5), Inches(9.7)]

# Header row
y_header = Inches(2.2)
header_h = Inches(0.7)

for i, (header, w, x) in enumerate(zip(headers, col_widths, x_positions)):
    header_shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y_header, w, header_h)
    header_shape.fill.solid()
    header_shape.fill.fore_color.rgb = BG_CARD
    header_shape.line.color.rgb = BORDER
    
    color = ACCENT if i == 3 else TEXT_PRIMARY
    bold = True if i == 3 else False
    
    add_text_box(slide, x + Inches(0.15), y_header + Inches(0.15), w - Inches(0.3), Inches(0.4),
                 header, font_size=15, bold=bold, color=color, alignment=PP_ALIGN.CENTER)

# Rows
rows = [
    ("Core Purpose", "File storage + citation formatting",
     "Single-task Q&A over papers",
     "Full-loop research collaboration"),
    ("AI Integration", "None (third-party plugins only)",
     "AI as standalone chat feature",
     "AI is the core product architecture"),
    ("Where It Works", "Desktop app + web dashboard",
     "Separate website",
     "Inside your browser, inline with papers"),
    ("Citation Trust", "You manually verify everything",
     "Some source linking",
     "100% traceable, multi-source verified"),
    ("Collaboration", "Shared libraries only",
     "Limited team features",
     "AI + human real-time co-editing"),
    ("Knowledge System", "Flat file structure",
     "Tag-based organization",
     "Dynamic knowledge graph"),
]

row_h = Inches(0.55)
for r_idx, (label, zot, elicit, pm) in enumerate(rows):
    y_row = y_header + header_h + r_idx * row_h
    
    # Alternate bg
    bg_color = RGBColor(0x17, 0x20, 0x30) if r_idx % 2 == 0 else BG_DARK
    
    for c_idx, (text, w, x) in enumerate(zip([label, zot, elicit, pm], col_widths, x_positions)):
        cell = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y_row, w, row_h)
        cell.fill.solid()
        cell.fill.fore_color.rgb = bg_color
        cell.line.color.rgb = BORDER
        
        color = ACCENT if c_idx == 3 else TEXT_PRIMARY
        bold = True if c_idx == 3 or c_idx == 0 else False
        
        add_text_box(slide, x + Inches(0.15), y_row + Inches(0.12), w - Inches(0.3), Inches(0.4),
                     text, font_size=13, bold=bold, color=color, alignment=PP_ALIGN.CENTER)


# ========== Slide 8: Business Model ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Business Model: Freemium Subscription", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "Fixed-price, all-inclusive subscription — no token surprises, no hidden fees.", font_size=18, color=TEXT_SECONDARY)

# Pricing tiers
tiers = [
    ("Free", "$0 / month",
     ["20 deep interactions / day",
      "Basic paper search & reading",
      "Core RAG Q&A",
      "Single user"], DANGER),
    ("Pro", "¥59 / month",
     ["Unlimited deep interactions",
      "Enhanced knowledge graph",
      "Priority model scheduling",
      "Full citation tracing",
      "~¥42/month with annual plan"], PRIMARY),
    ("Team / Lab", "¥299 / user / month",
     ["Everything in Pro",
      "Real-time collaboration",
      "Shared knowledge base",
      "Admin & role management",
      "Team annotation sync"], ACCENT),
    ("Enterprise", "Custom Annual",
     ["Everything in Team",
      "On-premise / private deployment",
      "Dedicated technical support",
      "Custom API integrations",
      "Institutional volume pricing"], SUCCESS),
]

tier_w = Inches(2.85)
tier_h = Inches(4.3)
tier_y = Inches(2.2)
tier_spacing = Inches(0.15)

for i, (name, price, features, color) in enumerate(tiers):
    x = Inches(0.8) + i * (tier_w + tier_spacing)
    
    card = add_rounded_rect(slide, x, tier_y, tier_w, tier_h)
    
    # Top accent bar
    top_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, tier_y, tier_w, Inches(0.08))
    top_bar.fill.solid()
    top_bar.fill.fore_color.rgb = color
    top_bar.line.fill.background()
    
    # Tier name
    add_text_box(slide, x + Inches(0.2), tier_y + Inches(0.25), tier_w - Inches(0.4), Inches(0.4),
                 name, font_size=18, bold=True, color=color, alignment=PP_ALIGN.CENTER)
    
    # Price
    add_text_box(slide, x + Inches(0.2), tier_y + Inches(0.7), tier_w - Inches(0.4), Inches(0.5),
                 price, font_size=22, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)
    
    # Divider
    divider = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x + Inches(0.3), tier_y + Inches(1.3), tier_w - Inches(0.6), Inches(0.02))
    divider.fill.solid()
    divider.fill.fore_color.rgb = BORDER
    divider.line.fill.background()
    
    # Features
    feat_text = "\n".join(["✓ " + f for f in features])
    add_text_box(slide, x + Inches(0.25), tier_y + Inches(1.5), tier_w - Inches(0.5), Inches(2.7),
                 feat_text, font_size=12, color=TEXT_PRIMARY)


# ========== Slide 9: Pricing Strategy Rationale ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.5), Inches(12), Inches(0.7),
             "Why Pure Subscription? The Industry Alternative Analysis", font_size=30, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.15), Inches(12), Inches(0.4),
             "We chose fixed-price subscription for one reason: academic users need predictable budgets.", font_size=16, color=TEXT_SECONDARY)

# Comparison table header
pricing_models = [
    ("Token-based\n(OpenAI, Elicit)", DANGER, 
     ["✗ Monthly bill unpredictable",
      "✗ Heavy users pay far more",
      "✗ 40% users exceed budget",
      "✗ Creates cost anxiety during use"]),
    ("Point/Credit System\n(Midjourney, Perplexity)", WARNING,
     ["✗ Long-term cost exceeds subscription",
      "✗ 27% higher churn vs subscription",
      "✗ Students dislike fragmentation",
      "✗ Use limits create anxiety"]),
    ("Hybrid: Base + Overage\n(Claude, Elicit Pro)", WARNING,
     ["✗ Complex rules confuse users",
      "✗ Fear of exceeding quota",
      "✗ Users reduce AI usage",
      "✗ Lower perceived value"]),
    ("Pure Subscription\n(PaperMind)", SUCCESS,
     ["✓ Fixed monthly cost, no surprises",
      "✓ Budget completely predictable",
      "✓ 32% higher conversion vs token",
      "✓ Aligns with academic budgets"]),
]

col_w = Inches(2.95)
col_h = Inches(4.2)
col_y = Inches(1.8)

for i, (model, color, points) in enumerate(pricing_models):
    x = Inches(0.65) + i * (col_w + Inches(0.15))
    
    card = add_rounded_rect(slide, x, col_y, col_w, col_h)
    
    # Top color bar
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, col_y, col_w, Inches(0.08))
    bar.fill.solid()
    bar.fill.fore_color.rgb = color
    bar.line.fill.background()
    
    # Model name
    add_text_box(slide, x + Inches(0.15), col_y + Inches(0.2), col_w - Inches(0.3), Inches(0.7),
                 model, font_size=14, bold=True, color=color, alignment=PP_ALIGN.CENTER)
    
    # Points
    points_text = "\n\n".join(points)
    add_text_box(slide, x + Inches(0.2), col_y + Inches(1), col_w - Inches(0.4), Inches(3),
                 points_text, font_size=12, color=TEXT_PRIMARY)

# Key insight box
insight_box = add_rounded_rect(slide, Inches(0.8), Inches(6.2), Inches(11.8), Inches(0.9))
add_text_box(slide, Inches(1.1), Inches(6.4), Inches(11), Inches(0.5),
             "📊 Research: Academic AI users prefer fixed subscription 3:1 over token billing. Stable budget = higher trust & renewal rate.",
             font_size=14, bold=True, color=ACCENT, alignment=PP_ALIGN.CENTER)


# ========== Slide 10: Go-to-Market & Growth ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Go-to-Market & Revenue Projection", font_size=36, bold=True, color=TEXT_PRIMARY)

# Left: GTM phases
left_x = Inches(0.8)
left_w = Inches(6)

add_text_box(slide, left_x, Inches(1.6), left_w, Inches(0.5),
             "Customer Acquisition Phases", font_size=20, bold=True, color=TEXT_PRIMARY)

phases = [
    ("Year 1: Seed Users",
     ["• Zhihu academic, Bilibili research creators",
      "• Reddit r/MachineLearning, Twitter/X academia",
      "• Campus events at top universities",
      "• 8,000 paying users target"]),
    ("Year 2: ARPU Growth",
     ["• Launch Team/Lab collaboration tier",
      "• Multi-language paper support",
      "• University official partnerships",
      "• 35,000 paying users target"]),
    ("Year 3+: Vertical Expansion",
     ["• Patents, medical, legal document analysis",
      "• Enterprise sales team for institutions",
      "• Private deployment contracts",
      "• 120,000 paying users target"]),
]

y = Inches(2.2)
for title, points in phases:
    add_card_with_title(slide, left_x, y, left_w, Inches(1.3), title, points, accent_color=PRIMARY)
    y += Inches(1.45)

# Right: Revenue projection
right_x = Inches(7.2)
right_w = Inches(5.4)

add_text_box(slide, right_x, Inches(1.6), right_w, Inches(0.5),
             "Conservative ARR Projection", font_size=20, bold=True, color=TEXT_PRIMARY)

revenues = [
    ("Year 1", "¥3.8M", "8K users", WARNING),
    ("Year 2", "¥18.5M", "35K users", ACCENT),
    ("Year 3", "¥68M", "120K users", SUCCESS),
]

y = Inches(2.2)
for year, amount, users, color in revenues:
    card = add_rounded_rect(slide, right_x, y, right_w, Inches(1.3))
    
    add_text_box(slide, right_x + Inches(0.3), y + Inches(0.15), Inches(2), Inches(1),
                 year, font_size=20, bold=True, color=color)
    
    add_text_box(slide, right_x + Inches(2.3), y + Inches(0.2), Inches(3), Inches(0.5),
                 amount, font_size=28, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.RIGHT)
    
    add_text_box(slide, right_x + Inches(2.3), y + Inches(0.75), Inches(3), Inches(0.4),
                 users, font_size=14, color=TEXT_SECONDARY, alignment=PP_ALIGN.RIGHT)
    
    y += Inches(1.45)


# ========== Slide 10: Risks & Mitigation ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Key Risks & Mitigation", font_size=36, bold=True, color=TEXT_PRIMARY)

add_text_box(slide, Inches(0.8), Inches(1.4), Inches(12), Inches(0.5),
             "Three critical risks — and how we address each.", font_size=18, color=TEXT_SECONDARY)

risks = [
    ("AI Output Credibility & Error Diffusion",
     "Risk: Full AI pipeline means errors can compound. A 'well-sourced' wrong answer is more dangerous than a bare hallucination.",
     "Mitigation: Show evidence strength + conflicting papers. Require 2+ independent sources for key claims. Confidence scores on all graph entities. Manual spot-check QA pipeline.",
     DANGER),
    ("Browser-Native Stability & Data Security",
     "Risk: Academic sites change layouts, breaking functionality. Users worry about research data privacy.",
     "Mitigation: Focus on top 5 platforms first for reliable UX. Automated regression testing + quick rollback. Minimum-permission design. Clear data flow transparency. Local/private deployment options.",
     WARNING),
    ("Team Collaboration: Versioning, Permissions, Accountability",
     "Risk: AI content shared across teams can spread errors fast. Unclear who reviewed what.",
     "Mitigation: Full version history (AI output + human edits + model version). Role-based access control per project. 'Pending / Verified / Citable' status workflow. Clear responsibility markers on all content.",
     ACCENT),
]

y = Inches(2.1)
for title, risk, mitigation, color in risks:
    card = add_rounded_rect(slide, Inches(0.8), y, Inches(11.8), Inches(1.55))
    
    # Title
    add_text_box(slide, Inches(1.1), y + Inches(0.12), Inches(11), Inches(0.4),
                 title, font_size=18, bold=True, color=color)
    
    # Risk line
    add_text_box(slide, Inches(1.1), y + Inches(0.5), Inches(11), Inches(0.45),
                 "⚠ Risk: " + risk, font_size=13, color=TEXT_SECONDARY)
    
    # Mitigation line
    add_text_box(slide, Inches(1.1), y + Inches(0.95), Inches(11), Inches(0.6),
                 "✓ Mitigation: " + mitigation, font_size=13, color=TEXT_PRIMARY)
    
    y += Inches(1.7)


# ========== Slide 11: Roadmap & Vision ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

add_text_box(slide, Inches(0.8), Inches(0.6), Inches(12), Inches(0.8),
             "Roadmap & Long-Term Vision", font_size=36, bold=True, color=TEXT_PRIMARY)

# Three phases of roadmap
phases = [
    ("Short-Term",
     "Leading browser-native\ncollaborative literature tool\nfor academic researchers",
     PRIMARY,
     ["Consolidate university users",
      "Polish browser-native experience",
      "Strengthen RAG & citation tracing"]),
    ("Medium-Term",
     "Expand to cross-industry\nknowledge workers\n(consulting, policy, engineering)",
     ACCENT,
     ["Industry-specific templates",
      "Legal / business / technical docs",
      "Enterprise API integrations"]),
    ("Long-Term",
     "Establish standard for traceable,\nevidence-based AI knowledge work",
     SUCCESS,
     ["Set accountability benchmarks",
      "Ecosystem of verifiable AI output",
      "Every AI conclusion traces to source"]),
]

phase_w = Inches(3.85)
phase_h = Inches(4.5)
phase_y = Inches(1.8)
phase_spacing = Inches(0.2)

for i, (title, vision, color, bullets) in enumerate(phases):
    x = Inches(0.8) + i * (phase_w + phase_spacing)
    
    card = add_rounded_rect(slide, x, phase_y, phase_w, phase_h)
    
    # Phase number
    add_text_box(slide, x, phase_y + Inches(0.2), phase_w, Inches(0.5),
                 f"Phase {i+1}", font_size=14, bold=True, color=color, alignment=PP_ALIGN.CENTER)
    
    # Title
    add_text_box(slide, x + Inches(0.2), phase_y + Inches(0.7), phase_w - Inches(0.4), Inches(0.5),
                 title, font_size=20, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)
    
    # Vision statement
    add_text_box(slide, x + Inches(0.2), phase_y + Inches(1.3), phase_w - Inches(0.4), Inches(1.2),
                 vision, font_size=15, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)
    
    # Divider
    divider = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x + Inches(0.5), phase_y + Inches(2.6), phase_w - Inches(1), Inches(0.02))
    divider.fill.solid()
    divider.fill.fore_color.rgb = BORDER
    divider.line.fill.background()
    
    # Bullets
    bullet_text = "\n".join(["• " + b for b in bullets])
    add_text_box(slide, x + Inches(0.3), phase_y + Inches(2.8), phase_w - Inches(0.6), Inches(1.5),
                 bullet_text, font_size=13, color=TEXT_PRIMARY)


# ========== Slide 12: Investment Ask & Closing ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

# Decorative background elements
circle_big = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(9), Inches(-2), Inches(7), Inches(7))
circle_big.fill.solid()
circle_big.fill.fore_color.rgb = RGBColor(0x1E, 0x29, 0x3B)
circle_big.line.fill.background()

circle_small = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(-1), Inches(5), Inches(4), Inches(4))
circle_small.fill.solid()
circle_small.fill.fore_color.rgb = RGBColor(0x1E, 0x29, 0x3B)
circle_small.line.fill.background()

# Headline
add_text_box(slide, Inches(0.8), Inches(0.8), Inches(12), Inches(1),
             "Join Us in Reinventing Research", font_size=40, bold=True, color=TEXT_PRIMARY)

# Core philosophy
philosophy_box = add_rounded_rect(slide, Inches(0.8), Inches(2), Inches(11.8), Inches(1))
add_text_box(slide, Inches(1.2), Inches(2.25), Inches(11), Inches(0.6),
             "Core Philosophy: We don't merely use AI — we build systems to harness AI responsibly.",
             font_size=18, bold=True, color=ACCENT, alignment=PP_ALIGN.CENTER)

# Investment ask
add_text_box(slide, Inches(0.8), Inches(3.4), Inches(12), Inches(0.5),
             "We're raising angel funding for three priorities:", font_size=20, bold=True, color=TEXT_PRIMARY)

priorities = [
    ("1", "Iterate AI Harness Engine", "Reduce hallucinations, improve citation accuracy", PRIMARY),
    ("2", "Scale User Acquisition", "University & academic conference partnerships", ACCENT),
    ("3", "Reinforce Competitive Edge", "Browser-native collaborative experience", SUCCESS),
]

y = Inches(4.1)
for num, title, desc, color in priorities:
    # Number circle
    circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(1.5), y, Inches(0.6), Inches(0.6))
    circle.fill.solid()
    circle.fill.fore_color.rgb = color
    circle.line.fill.background()
    
    add_text_box(slide, Inches(1.5), y + Inches(0.1), Inches(0.6), Inches(0.4),
                 num, font_size=18, bold=True, color=BG_DARK, alignment=PP_ALIGN.CENTER)
    
    add_text_box(slide, Inches(2.4), y + Inches(0.05), Inches(8), Inches(0.35),
                 title, font_size=16, bold=True, color=TEXT_PRIMARY)
    
    add_text_box(slide, Inches(2.4), y + Inches(0.38), Inches(8), Inches(0.3),
                 desc, font_size=13, color=TEXT_SECONDARY)
    
    y += Inches(0.75)

# Closing slogan
add_text_box(slide, Inches(0.8), Inches(6.5), Inches(12), Inches(0.6),
             "Turn scattered literature into connected, verifiable knowledge.",
             font_size=22, bold=True, color=PRIMARY, alignment=PP_ALIGN.CENTER)


# ========== Slide 13: Q&A ==========
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide, BG_DARK)

# Center content
add_text_box(slide, Inches(0.8), Inches(2.5), Inches(12), Inches(1.5),
             "Q & A", font_size=80, bold=True, color=TEXT_PRIMARY, alignment=PP_ALIGN.CENTER)

add_text_box(slide, Inches(0.8), Inches(4.2), Inches(12), Inches(0.6),
             "Thank you for your time.", font_size=24, color=TEXT_SECONDARY, alignment=PP_ALIGN.CENTER)

add_text_box(slide, Inches(0.8), Inches(5), Inches(12), Inches(0.6),
             "PaperMind — Browser-Native AI Research Co-Pilot", font_size=18, color=ACCENT, alignment=PP_ALIGN.CENTER)

# Save
output_path = r"d:\My Data\Documents\_My Documents\Projects\AI\PaperMind\PaperMind_Presentation_v2.pptx"
prs.save(output_path)
print(f"Presentation saved to: {output_path}")
print(f"Total slides: {len(prs.slides)}")
