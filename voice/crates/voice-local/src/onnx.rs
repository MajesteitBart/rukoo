//! Reads an ONNX model's metadata without loading the model.
//!
//! An ONNX file is a protobuf `ModelProto`. Its metadata are top-level `metadata_props` entries,
//! usually after the graph, so this walks the top-level field headers and seeks past the rest.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;

/// `ModelProto.metadata_props`.
const METADATA_PROPS: u64 = 14;
/// Real metadata entries are a few bytes; a bigger one means the length is damaged.
const MAX_ENTRY: u64 = 1024 * 1024;

/// The `metadata_props` of the model at `path` as key and value pairs, or `None` when the file
/// isn't a well-formed `ModelProto` at its top level.
pub fn metadata(path: &Path) -> io::Result<Option<Vec<(String, String)>>> {
    let file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut position = 0;
    let mut entries = Vec::new();
    while position < len {
        let Some((tag, used)) = read_varint(&mut reader)? else {
            return Ok(None);
        };
        position += used;
        let field = tag >> 3;
        if field == 0 {
            return Ok(None);
        }
        let skip = match tag & 7 {
            0 => {
                let Some((_, used)) = read_varint(&mut reader)? else {
                    return Ok(None);
                };
                position += used;
                0
            }
            1 => 8,
            5 => 4,
            2 => {
                let Some((size, used)) = read_varint(&mut reader)? else {
                    return Ok(None);
                };
                position += used;
                if field != METADATA_PROPS {
                    size
                } else if size > MAX_ENTRY || size > len - position {
                    return Ok(None);
                } else {
                    let mut body = vec![0; size as usize];
                    reader.read_exact(&mut body)?;
                    position += size;
                    match entry(&body) {
                        Some(entry) => entries.push(entry),
                        None => return Ok(None),
                    }
                    0
                }
            }
            _ => return Ok(None),
        };
        if skip > len - position {
            return Ok(None);
        }
        reader.seek_relative(skip as i64)?;
        position += skip;
    }
    Ok(Some(entries))
}

/// A `StringStringEntryProto`: key in field 1, value in field 2.
fn entry(mut body: &[u8]) -> Option<(String, String)> {
    let (mut key, mut value) = (String::new(), String::new());
    while !body.is_empty() {
        let (tag, _) = read_varint(&mut body).ok()??;
        match tag & 7 {
            0 => {
                read_varint(&mut body).ok()??;
            }
            2 => {
                let (size, _) = read_varint(&mut body).ok()??;
                let size = usize::try_from(size)
                    .ok()
                    .filter(|&size| size <= body.len())?;
                let (bytes, rest) = body.split_at(size);
                body = rest;
                match tag >> 3 {
                    1 => key = String::from_utf8(bytes.to_vec()).ok()?,
                    2 => value = String::from_utf8(bytes.to_vec()).ok()?,
                    _ => {}
                }
            }
            _ => return None,
        }
    }
    Some((key, value))
}

/// A base-128 varint and the bytes it took, or `None` at the end of the input or after ten bytes.
fn read_varint<R: Read>(input: &mut R) -> io::Result<Option<(u64, u64)>> {
    let mut value = 0;
    for count in 0..10 {
        let mut byte = [0];
        match input.read_exact(&mut byte) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error),
        }
        value |= u64::from(byte[0] & 0x7f) << (7 * count);
        if byte[0] < 0x80 {
            return Ok(Some((value, count + 1)));
        }
    }
    Ok(None)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn varint(mut value: u64, out: &mut Vec<u8>) {
        while value >= 0x80 {
            out.push((value as u8) | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }

    fn bytes_field(field: u64, body: &[u8], out: &mut Vec<u8>) {
        varint(field << 3 | 2, out);
        varint(body.len() as u64, out);
        out.extend_from_slice(body);
    }

    /// A `ModelProto` with an opaque graph and the given metadata, in the order ONNX exporters
    /// write them.
    pub fn model(metadata: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        varint(1 << 3, &mut out);
        varint(8, &mut out);
        bytes_field(2, b"pytorch", &mut out);
        bytes_field(7, &[0x55; 300], &mut out);
        out.extend_from_slice(&[(9 << 3) | 5, 1, 2, 3, 4]);
        for (key, value) in metadata {
            let mut entry = Vec::new();
            bytes_field(1, key.as_bytes(), &mut entry);
            bytes_field(2, value.as_bytes(), &mut entry);
            bytes_field(METADATA_PROPS, &entry, &mut out);
        }
        out
    }

    fn write(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rukoo-voice-local-onnx-{name}-{}.onnx",
            std::process::id()
        ));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_metadata_after_the_graph() {
        let path = write("ok", &model(&[("vocab_size", "8192"), ("comment", "é")]));
        assert_eq!(
            metadata(&path).unwrap(),
            Some(vec![
                ("vocab_size".into(), "8192".into()),
                ("comment".into(), "é".into())
            ])
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_damaged_file_is_not_a_model() {
        let whole = model(&[("vocab_size", "8192")]);
        for (name, bytes) in [
            ("truncated", whole[..whole.len() - 3].to_vec()),
            ("cut-in-graph", whole[..100].to_vec()),
            ("text", b"not an onnx model".to_vec()),
            ("zeros", vec![0; 64]),
            ("group", vec![(1 << 3) | 3, 0]),
        ] {
            let path = write(name, &bytes);
            assert_eq!(metadata(&path).unwrap(), None, "{name}");
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn an_empty_file_has_no_metadata() {
        let path = write("empty", b"");
        assert_eq!(metadata(&path).unwrap(), Some(Vec::new()));
        fs::remove_file(path).unwrap();
    }
}
