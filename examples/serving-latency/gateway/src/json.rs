//! A minimal JSON writer, for the run's results.

use std::fmt::Write;

pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn obj<K: Into<String>>(fields: impl IntoIterator<Item = (K, Json)>) -> Json {
        Json::Obj(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    pub fn nums(values: impl IntoIterator<Item = f64>) -> Json {
        Json::Arr(values.into_iter().map(Json::Num).collect())
    }

    pub fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => {
                if !n.is_finite() {
                    out.push_str("null")
                } else if n.fract() == 0.0 && n.abs() < 1e15 {
                    write!(out, "{}", *n as i64).unwrap()
                } else {
                    // 6 significant digits are plenty, and keep files small
                    let s = format!("{:.5e}", n);
                    let v: f64 = s.parse().unwrap();
                    write!(out, "{}", v).unwrap()
                }
            }
            Json::Str(s) => {
                out.push('"');
                for c in s.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        '\t' => out.push_str("\\t"),
                        c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    Json::Str(k.clone()).write(out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

}

impl std::fmt::Display for Json {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let mut s = String::new();
        self.write(&mut s);
        f.write_str(&s)
    }
}

impl From<f64> for Json {
    fn from(v: f64) -> Json {
        Json::Num(v)
    }
}
impl From<u64> for Json {
    fn from(v: u64) -> Json {
        Json::Num(v as f64)
    }
}
impl From<usize> for Json {
    fn from(v: usize) -> Json {
        Json::Num(v as f64)
    }
}
impl From<&str> for Json {
    fn from(v: &str) -> Json {
        Json::Str(v.to_string())
    }
}
impl From<String> for Json {
    fn from(v: String) -> Json {
        Json::Str(v)
    }
}
impl From<bool> for Json {
    fn from(v: bool) -> Json {
        Json::Bool(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_json() {
        let j = Json::obj([("a", Json::nums([1.0, 0.5, f64::NAN])), ("b", "x\"y\n".into()), ("c", Json::Bool(true))]);
        assert_eq!(j.to_string(), r#"{"a":[1,0.5,null],"b":"x\"y\n","c":true}"#);
        assert_eq!(Json::Num(1.0 / 3.0).to_string(), "0.333333");
    }
}
