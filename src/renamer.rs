use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum RenameRule {
    #[serde(rename = "search_replace")]
    SearchReplace { search: String, replace: String },
    #[serde(rename = "regex")]
    RegexReplace { pattern: String, replace: String },
    #[serde(rename = "prefix_suffix")]
    PrefixSuffix {
        #[serde(default)]
        prefix: String,
        #[serde(default)]
        suffix: String,
    },
    #[serde(rename = "numbering")]
    Numbering {
        #[serde(default = "default_start")]
        start: usize,
        #[serde(default = "default_step")]
        step: usize,
        #[serde(default = "default_padding")]
        padding: usize,
        #[serde(default)]
        position: NumberPosition,
        #[serde(default)]
        separator: String,
    },
    #[serde(rename = "case")]
    ChangeCase { case_type: CaseType },
    #[serde(rename = "repad")]
    Repad {
        #[serde(default = "default_repad_padding")]
        padding: usize,
    },
}

fn default_start() -> usize { 1 }
fn default_step() -> usize { 1 }
fn default_padding() -> usize { 3 }
fn default_repad_padding() -> usize { 0 } // 0 = auto-detect

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum NumberPosition {
    #[default]
    #[serde(rename = "prefix")]
    Prefix,
    #[serde(rename = "suffix")]
    Suffix,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CaseType {
    #[serde(rename = "upper")]
    Upper,
    #[serde(rename = "lower")]
    Lower,
    #[serde(rename = "title")]
    Title,
    #[serde(rename = "camel")]
    Camel,
    #[serde(rename = "snake")]
    Snake,
    #[serde(rename = "kebab")]
    Kebab,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenamePreview {
    pub original: String,
    pub renamed: String,
    pub changed: bool,
}

pub fn apply_rule(filenames: &[String], rule: &RenameRule) -> Result<Vec<RenamePreview>, String> {
    // For repad with auto-detect (padding=0), find the max number width across all files
    let repad_width = if let RenameRule::Repad { padding } = rule {
        if *padding == 0 {
            auto_detect_padding(filenames)
        } else {
            *padding
        }
    } else {
        0
    };

    let mut results = Vec::with_capacity(filenames.len());

    for (i, name) in filenames.iter().enumerate() {
        let (stem, ext) = split_name_ext(name);
        let new_stem = match rule {
            RenameRule::SearchReplace { search, replace } => {
                stem.replace(search.as_str(), replace.as_str())
            }
            RenameRule::RegexReplace { pattern, replace } => {
                let re = Regex::new(pattern).map_err(|e| format!("Regex invalide: {e}"))?;
                re.replace_all(&stem, replace.as_str()).into_owned()
            }
            RenameRule::PrefixSuffix { prefix, suffix } => {
                format!("{prefix}{stem}{suffix}")
            }
            RenameRule::Numbering {
                start,
                step,
                padding,
                position,
                separator,
            } => {
                let num = start + i * step;
                let num_str = format!("{:0>width$}", num, width = *padding);
                match position {
                    NumberPosition::Prefix => format!("{num_str}{separator}{stem}"),
                    NumberPosition::Suffix => format!("{stem}{separator}{num_str}"),
                }
            }
            RenameRule::ChangeCase { case_type } => apply_case(&stem, case_type),
            RenameRule::Repad { .. } => repad_numbers(&stem, repad_width),
        };

        let renamed = if ext.is_empty() {
            new_stem.clone()
        } else {
            format!("{new_stem}.{ext}")
        };

        let changed = *name != renamed;
        results.push(RenamePreview {
            original: name.clone(),
            renamed,
            changed,
        });
    }

    Ok(results)
}

fn auto_detect_padding(filenames: &[String]) -> usize {
    let re = Regex::new(r"\d+").unwrap();
    let mut max_digits = 0;
    for name in filenames {
        let (stem, _) = split_name_ext(name);
        for m in re.find_iter(&stem) {
            let val: usize = m.as_str().parse().unwrap_or(0);
            let needed = if val == 0 { 1 } else { (val as f64).log10().floor() as usize + 1 };
            if needed > max_digits {
                max_digits = needed;
            }
        }
    }
    max_digits
}

fn repad_numbers(stem: &str, width: usize) -> String {
    let re = Regex::new(r"\d+").unwrap();
    let mut result = String::new();
    let mut last_end = 0;

    for m in re.find_iter(stem) {
        result.push_str(&stem[last_end..m.start()]);
        let num: usize = m.as_str().parse().unwrap_or(0);
        result.push_str(&format!("{:0>width$}", num, width = width));
        last_end = m.end();
    }
    result.push_str(&stem[last_end..]);
    result
}

fn split_name_ext(filename: &str) -> (String, String) {
    if let Some(dot_pos) = filename.rfind('.') {
        if dot_pos > 0 {
            return (
                filename[..dot_pos].to_string(),
                filename[dot_pos + 1..].to_string(),
            );
        }
    }
    (filename.to_string(), String::new())
}

fn apply_case(s: &str, case_type: &CaseType) -> String {
    match case_type {
        CaseType::Upper => s.to_uppercase(),
        CaseType::Lower => s.to_lowercase(),
        CaseType::Title => to_title_case(s),
        CaseType::Camel => to_camel_case(s),
        CaseType::Snake => to_snake_case(s),
        CaseType::Kebab => to_kebab_case(s),
    }
}

fn split_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();

    for ch in s.chars() {
        if ch == '_' || ch == '-' || ch == ' ' || ch == '.' {
            if !current.is_empty() {
                words.push(current.clone());
                current.clear();
            }
        } else if ch.is_uppercase() && !current.is_empty() && current.chars().last().map_or(false, |c| c.is_lowercase()) {
            words.push(current.clone());
            current.clear();
            current.push(ch);
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn to_title_case(s: &str) -> String {
    split_words(s)
        .iter()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_uppercase().to_string() + &chars.as_str().to_lowercase(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn to_camel_case(s: &str) -> String {
    let words = split_words(s);
    let mut result = String::new();
    for (i, w) in words.iter().enumerate() {
        if i == 0 {
            result.push_str(&w.to_lowercase());
        } else {
            let mut chars = w.chars();
            if let Some(c) = chars.next() {
                result.push_str(&c.to_uppercase().to_string());
                result.push_str(&chars.as_str().to_lowercase());
            }
        }
    }
    result
}

fn to_snake_case(s: &str) -> String {
    split_words(s)
        .iter()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join("_")
}

fn to_kebab_case(s: &str) -> String {
    split_words(s)
        .iter()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join("-")
}
