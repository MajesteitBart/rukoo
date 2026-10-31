//! Every text-cleanup vector from ownkey-providers.md sections 10.5, 12 and 13, and the
//! quirks Voice fixes on purpose (decision 8).

use serde_json::json;
use voice_core::cleanup::{
    apply_corrections, clean, filler_words, normalize_corrections, normalize_filler_languages,
    normalize_vocabulary, remove_fillers, CleanupConfig, Correction, FILLER_SAMPLE,
};

fn w() -> Vec<String> {
    filler_words(&["en", "nl"], "")
}

fn rule(from: &str, to: &str) -> Correction {
    Correction::new(from, to)
}

#[track_caller]
fn check_fillers(input: &str, words: &[String], expected: &str) {
    assert_eq!(remove_fillers(input, words), expected, "input: {input:?}");
}

#[test]
fn ownkey_filler_vectors() {
    // tests/test_text_cleanup.py, lines 21-76 (13.1)
    let w = w();
    check_fillers(
        "I think, uh, we should ship it.",
        &w,
        "I think, we should ship it.",
    );
    check_fillers(
        "I think uh, we should ship it.",
        &w,
        "I think we should ship it.",
    );
    check_fillers(
        "I think uh we should ship it.",
        &w,
        "I think we should ship it.",
    );
    check_fillers("Um, hello there.", &w, "Hello there.");
    check_fillers("Yes. Uh, then we left.", &w, "Yes. Then we left.");
    check_fillers("Um. Hello.", &w, "Hello.");
    check_fillers("We should go, uh.", &w, "We should go.");
    check_fillers("I think, uh. We should go.", &w, "I think. We should go.");
    check_fillers("Dat is uh uhm, ehm goed.", &w, "Dat is goed.");
    check_fillers(
        "Dat is, eh, gewoon dus goed.",
        &w,
        "Dat is, gewoon dus goed.",
    );
    check_fillers(
        "Uh-huh, that is like, well, fine.",
        &w,
        "Uh-huh, that is like, well, fine.",
    );
    check_fillers("Er is een umbrella.", &w, "Er is een umbrella.");
    check_fillers("Hmm, not sure.", &w, "Hmm, not sure.");
    check_fillers(
        "Wir gehen um acht.",
        &filler_words(&["en", "de"], ""),
        "Wir gehen um acht.",
    );
    check_fillers(
        "So basically, we, basically, left.",
        &filler_words(&["en"], "basically"),
        "So we, left.",
    );
    check_fillers("uh uh", &Vec::<String>::new(), "uh uh");
    check_fillers("", &w, "");
    check_fillers(
        "First line, uh.\num second line",
        &w,
        "First line.\nSecond line",
    );
    check_fillers("First line\num second line", &w, "First line\nSecond line");
    check_fillers(
        "First line,\num second line",
        &w,
        "First line,\nSecond line",
    );
    check_fillers(
        "Eerste alinea.\n\nUhm tweede alinea.",
        &w,
        "Eerste alinea.\n\nTweede alinea.",
    );
    check_fillers("Um, iPhone works.", &w, "iPhone works.");
    check_fillers("Yes. Um, eBay works.", &w, "Yes. eBay works.");
    check_fillers("Um, NASA works.", &w, "NASA works.");
}

#[test]
fn filler_word_lists_and_languages() {
    // 13.2
    assert!(filler_words(&["en"], "").contains(&"er".to_string()));
    assert!(!filler_words(&["en", "nl"], "").contains(&"er".to_string()));
    assert!(filler_words(&["en"], "").contains(&"um".to_string()));
    assert!(!filler_words(&["en", "de"], "").contains(&"um".to_string()));
    assert_eq!(normalize_filler_languages(&json!([])), Vec::<String>::new());
    assert_eq!(normalize_filler_languages(&json!(null)), vec!["en", "nl"]);
    assert_eq!(normalize_filler_languages(&json!("en")), vec!["en", "nl"]);
    assert_eq!(
        normalize_filler_languages(&json!(["NL", "xx", "nl"])),
        vec!["nl"]
    );
    assert_eq!(
        filler_words(&Vec::<String>::new(), ""),
        Vec::<String>::new()
    );
    assert_eq!(
        filler_words(&Vec::<String>::new(), "basically"),
        vec!["basically"]
    );
    // 13.5
    assert_eq!(
        normalize_filler_languages(&json!(["de", "DE", "fr"])),
        vec!["de", "fr"]
    );
    // Python's set has no JSON form; any non-list is "malformed" and gives the defaults.
    assert_eq!(
        normalize_filler_languages(&json!({"en": true})),
        vec!["en", "nl"]
    );
}

#[test]
fn computed_filler_lists() {
    // 10.5, observed lists
    let cases: [(&[&str], &str, &str); 11] = [
        (&["en"], "", "uh, uhh, um, umm, uhm, erm, er, mhm"),
        (&["nl"], "", "uh, uhm, eh, ehm, euh, euhm, hm"),
        (&["de"], "", "\u{e4}h, \u{e4}hm, ehm, hm, mh"),
        (&["fr"], "", "euh, heu, hum"),
        (&["es"], "", "eh, em, ehm, este"),
        (&["en", "nl"], "", "uh, uhh, um, umm, uhm, erm, mhm, eh, ehm, euh, euhm, hm"),
        (&["en", "de"], "", "uh, uhh, umm, uhm, erm, mhm, \u{e4}h, \u{e4}hm, ehm, hm, mh"),
        (&["es", "nl"], "", "eh, em, ehm, uh, uhm, euh, euhm, hm"),
        (&["es", "en"], "", "eh, em, ehm, este, uh, uhh, um, umm, uhm, erm, mhm"),
        (
            &["en", "nl", "de", "fr", "es"],
            "",
            "uh, uhh, umm, uhm, erm, mhm, eh, ehm, euh, euhm, hm, \u{e4}h, \u{e4}hm, mh, heu, hum, em",
        ),
        (&["en"], "Basically, UH, actually", "uh, uhh, um, umm, uhm, erm, er, mhm, basically, actually"),
    ];
    for (languages, custom, expected) in cases {
        assert_eq!(
            filler_words(languages, custom).join(", "),
            expected,
            "{languages:?} {custom:?}"
        );
    }
    assert_eq!(
        filler_words(&["en"], "Like, like").join(", "),
        "uh, uhh, um, umm, uhm, erm, er, mhm, like"
    );
    // Custom words bypass the protection of other languages.
    assert!(filler_words(&["en", "nl"], "er").contains(&"er".to_string()));
}

#[test]
fn corrections_and_vocabulary() {
    // 13.3
    assert_eq!(
        apply_corrections(
            "Own key is by bart, not bartender.",
            &[rule("own key", "Ownkey"), rule("bart", "Bart")]
        ),
        "Ownkey is by Bart, not bartender."
    );
    assert_eq!(
        normalize_corrections(&json!([
            {"from": " a ", "to": "b"},
            {"from": "a", "to": "c"},
            ["x", ""],
            ["same", "Same"],
            "junk",
            ["p", "q"]
        ])),
        vec![rule("a", "b"), rule("same", "Same"), rule("p", "q")]
    );
    assert_eq!(
        normalize_vocabulary(&json!(["Ownkey", " ownkey ", "", "Orukeet\tv1"])),
        vec!["Ownkey", "Orukeet v1"]
    );
    assert_eq!(normalize_vocabulary(&json!("a, b\nc")), vec!["a", "b", "c"]);
    assert_eq!(normalize_vocabulary(&json!(null)), Vec::<String>::new());

    // 13.5
    let own_key = [rule("own key", "Ownkey")];
    assert_eq!(apply_corrections("OWN KEY works", &own_key), "Ownkey works");
    assert_eq!(apply_corrections("own key's", &own_key), "Ownkey's");
    assert_eq!(apply_corrections("own-key", &own_key), "own-key");
    assert_eq!(apply_corrections("own  key", &own_key), "own  key");
    assert_eq!(
        apply_corrections("bart_x bart", &[rule("bart", "Bart")]),
        "bart_x Bart"
    );
    assert_eq!(
        apply_corrections(
            "\u{c9}COLE ecole \u{e9}cole",
            &[rule("\u{e9}cole", "\u{c9}cole")]
        ),
        "\u{c9}cole ecole \u{c9}cole"
    );
    assert_eq!(
        apply_corrections("x", &[rule("x", r"\1 $1 \g<0>")]),
        r"\1 $1 \g<0>"
    );
    assert_eq!(
        normalize_corrections(&json!([["ownkey", "Ownkey"], ["Ownkey", "Ownkey"]])),
        vec![rule("ownkey", "Ownkey")]
    );
    assert_eq!(
        normalize_corrections(&json!([{"from": "A", "to": "b"}, {"from": "a", "to": "c"}])),
        vec![rule("A", "b")]
    );
    assert_eq!(
        normalize_corrections(
            &json!([{"from": "a"}, {"to": "b"}, ["a", "b", "c"], [" x  y ", " z "]])
        ),
        vec![rule("x y", "z")]
    );
    assert_eq!(
        normalize_corrections(&json!({"from": "a", "to": "b"})),
        Vec::<Correction>::new()
    );
    assert_eq!(
        normalize_vocabulary(&json!("x,,y\n\nz, X")),
        vec!["x", "y", "z"]
    );
}

#[test]
fn correction_order_and_edges() {
    // 10.4
    assert_eq!(
        apply_corrections("a", &[rule("a", "b"), rule("b", "c")]),
        "c"
    );
    assert_eq!(
        apply_corrections("a", &[rule("b", "c"), rule("a", "b")]),
        "b"
    );
    assert_eq!(
        apply_corrections("c++ and c++x and xc++", &[rule("c++", "C++")]),
        "C++ and c++x and xc++"
    );
    assert_eq!(
        apply_corrections(
            "new york city",
            &[rule("york city", "YC"), rule("new york", "NY")]
        ),
        "new YC"
    );
    // Fillers run first, so a source that contains a filler never matches (10.1).
    let cfg = CleanupConfig {
        corrections: vec![rule("uh huh", "yes")],
        ..CleanupConfig::default()
    };
    assert_eq!(clean("uh huh", &cfg), "Huh");
}

#[test]
fn pipeline() {
    // 13.4
    let only_custom = CleanupConfig {
        remove_fillers: true,
        filler_languages: vec![],
        custom_fillers: "basically".into(),
        corrections: vec![],
    };
    assert_eq!(
        clean("Um, we basically left.", &only_custom),
        "Um, we left."
    );
    let with_correction = CleanupConfig {
        corrections: vec![rule("own key", "Ownkey")],
        ..CleanupConfig::default()
    };
    assert_eq!(
        clean("Um, own key uh works.", &with_correction),
        "Ownkey works."
    );
    let off = CleanupConfig {
        remove_fillers: false,
        ..CleanupConfig::default()
    };
    assert_eq!(clean("Um, hello.", &off), "Um, hello.");
    // 13.5: a missing language list means the defaults.
    let defaults = CleanupConfig {
        filler_languages: normalize_filler_languages(&json!(null)),
        ..CleanupConfig::default()
    };
    assert_eq!(clean("Um, hello", &defaults), "Hello");
    assert_eq!(clean("", &CleanupConfig::default()), "");
}

#[test]
fn settings_sample_per_language() {
    // 13.5
    let all = filler_words(&["en", "nl", "de", "fr", "es"], "");
    check_fillers(
        FILLER_SAMPLE,
        &w(),
        "I think, we should ship it on Tuesday. Er is nog \u{e9}\u{e9}n ding.",
    );
    check_fillers(
        FILLER_SAMPLE,
        &filler_words(&["en"], ""),
        "I think, we should ehm ship it on Tuesday. Is nog \u{e9}\u{e9}n ding.",
    );
    check_fillers(
        FILLER_SAMPLE,
        &filler_words(&["nl"], ""),
        "Um, I think, we should ship it on Tuesday. Er is nog \u{e9}\u{e9}n ding.",
    );
    check_fillers(FILLER_SAMPLE, &Vec::<String>::new(), FILLER_SAMPLE);
    check_fillers(
        FILLER_SAMPLE,
        &all,
        "Um, I think, we should ship it on Tuesday. Er is nog \u{e9}\u{e9}n ding.",
    );
}

#[test]
fn extra_observed_vectors() {
    // 13.5
    let w = w();
    let german = filler_words(&["en", "nl", "de"], "");
    check_fillers("\u{c4}hm, wir gehen.", &german, "Wir gehen.");
    check_fillers("Also \u{e4}h wir gehen.", &german, "Also wir gehen.");
    check_fillers("\u{c4}H, gut", &german, "Gut");
    check_fillers("UH, HELLO", &w, "HELLO");
    check_fillers("Um, 'hello' there", &w, "'hello' there");
    check_fillers("Um, \u{e9}lan vital", &w, "\u{c9}lan vital");
    check_fillers("Um, \u{fc}nd", &w, "\u{dc}nd");
    check_fillers("first, um, second, uh, third", &w, "first, second, third");
    check_fillers("One, uh, two, um, three.", &w, "One, two, three.");
    check_fillers("Well uh uh uh, fine", &w, "Well fine");
    check_fillers("don't uh worry", &w, "don't worry");
    check_fillers("It\u{2019}s uh fine", &w, "It\u{2019}s fine");
    check_fillers("uh\u{2019}s", &w, "uh\u{2019}s");
    check_fillers("Hello uh", &w, "Hello");
    check_fillers("Hello uh?", &w, "Hello?");
    check_fillers("Okay. Um.", &w, "Okay.");
    check_fillers("Um... hello", &w, "Hello");
    check_fillers("  leading spaces um ok  ", &w, "leading spaces ok");
    check_fillers("Tekst ehm\n\nTweede", &w, "Tekst\n\nTweede");
    check_fillers("Hello.\nUm, world", &w, "Hello.\nWorld");
    check_fillers("um, 42 dingen", &w, "42 dingen");
}

#[test]
fn intended_ownkey_behavior_is_kept() {
    // Section 12, "behavior that looks odd but is probably intended".
    let w = w();
    check_fillers("uh", &w, "");
    check_fillers("hm hm hm.", &w, "");
    check_fillers("Um\nhello", &w, "Hello");
    check_fillers("Ja\u{2026} ehm, goed", &w, "Ja\u{2026} Goed");
    check_fillers("Yes! Uh, no", &w, "Yes! No");
    check_fillers("Wait uh; then", &w, "Wait then");
    check_fillers("Wait, uh: then", &w, "Wait, then");
    check_fillers("The er value", &w, "The er value");
    check_fillers("It's uhm\u{2014}fine", &w, "It's uhm\u{2014}fine");
    check_fillers("Uh,uh hello", &w, "Uh,uh hello");
    // These two match Ownkey too: the filler's own line goes away with it, which is right.
    check_fillers("Hello,\nuh,\nworld", &w, "Hello,\nWorld");
    check_fillers("x\n\n  um  \n\ny", &w, "x\n\nY");
    // CRLF line breaks stay as they are.
    check_fillers("line one\r\num line two", &w, "line one\r\nLine two");
}

#[test]
fn ownkey_quirks_fixed_on_purpose() {
    // Section 12, first table. Ownkey's output is in each comment.
    let w = w();
    // "hello": the second sentence-start mark was swallowed by the first.
    check_fillers("Uh. uh. hello", &w, "Hello");
    // ".": a stray period from a filler removed earlier in the same pass.
    check_fillers("Uh, um.", &w, "");
    // ". Hello"
    check_fillers("Um, uh. Hello", &w, "Hello");
    // "I think. we go": the ellipsis collapsed to a period.
    check_fillers("I think uh... we go", &w, "I think... we go");
    check_fillers("I think, uh... we go", &w, "I think... we go");
    // "Go? Now"
    check_fillers("Go uh?! Now", &w, "Go?! Now");
    // "Hello. World": the line break after the filler was lost.
    check_fillers("Hello. Um\nworld", &w, "Hello.\nWorld");
    // "Quoi? Bonjour!": French spacing was removed although no filler matched.
    check_fillers("Quoi ? Bonjour  !", &w, "Quoi ? Bonjour  !");
    // "a b c"
    check_fillers("a  b\t\tc", &w, "a  b\t\tc");
    // "word,uh next"
    check_fillers("word ,uh next", &w, "word ,uh next");
    // "SSe": a capital that changes the word's length.
    check_fillers("Um, \u{df}e", &w, "\u{df}e");
    // Ownkey collapsed the double space here too ("So it works, you know."); spacing the
    // filler didn't touch now stays.
    check_fillers(
        "So you know, it works, you  know.",
        &filler_words(&["en", "nl"], "you know"),
        "So it works, you  know.",
    );
}
