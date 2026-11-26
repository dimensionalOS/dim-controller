//! Each dimos HardwareModule's hardware.usda and the files it names, kept on disk by sha256 (`<dataDir>/hardware_cache`)
//! from every hardware_file_response heard on the bus (whoever asked), so a recording can hold them though the page
//! that asked is long gone. A module answers on `<namespace>/hardware_file_response` with a files.FileInfo
//! (dimos/msgs/files/FileInfo.py, byte for byte as the frontend's core/fileInfo.ts), asked on
//! `<namespace>/hardware_file_request` with one naming the uri (and the sha256 already held, If-None-Match style).
//! A recording's start writes each known module's files into it from here and asks for what's missing; a recording
//! read back (`load_mcap`) fills the cache from its FileInfo channels, so a replay draws the hardware too.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Result};

/// the name every HardwareModule serves its USD as
pub const HARDWARE_USD: &str = "hardware.usda";
pub const FILE_INFO_TYPE: &str = "files.FileInfo";
/// every module's answers, at any depth (zenoh's `**` also matches none: the top level's)
pub const RESPONSES: &str = "dimos/**/hardware_file_response/files.FileInfo";

const HAS_SHA256: u8 = 1;
const HAS_MTIME: u8 = 2;
const HAS_CONTENT: u8 = 4;

#[derive(Clone, Debug, PartialEq, Default)]
pub struct FileInfo {
    /// seconds since the epoch the message was made
    pub ts: f64,
    /// relative to the module that serves it
    pub uri: String,
    /// `sha256:<64 hex>`
    pub sha256: Option<String>,
    pub mtime: Option<f64>,
    /// None: a header only
    pub content: Option<Vec<u8>>,
}

/// `<f64 ts><u8 flags><u32 uri length><uri>[<u16 hash length><hash>][<f64 mtime>][content: the rest]`, little-endian.
pub fn encode_file_info(info: &FileInfo) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + info.uri.len() + info.content.as_ref().map_or(0, Vec::len));
    out.extend_from_slice(&info.ts.to_le_bytes());
    let flags = if info.sha256.is_some() { HAS_SHA256 } else { 0 } | if info.mtime.is_some() { HAS_MTIME } else { 0 } | if info.content.is_some() { HAS_CONTENT } else { 0 };
    out.push(flags);
    out.extend_from_slice(&(info.uri.len() as u32).to_le_bytes());
    out.extend_from_slice(info.uri.as_bytes());
    if let Some(hash) = &info.sha256 {
        out.extend_from_slice(&(hash.len() as u16).to_le_bytes());
        out.extend_from_slice(hash.as_bytes());
    }
    if let Some(mtime) = info.mtime {
        out.extend_from_slice(&mtime.to_le_bytes());
    }
    if let Some(content) = &info.content {
        out.extend_from_slice(content);
    }
    out
}

pub fn decode_file_info(bytes: &[u8]) -> Result<FileInfo> {
    let need = |at: usize, length: usize| -> Result<()> {
        if at + length > bytes.len() {
            bail!("files.FileInfo cut short: {} bytes, its header needs {}", bytes.len(), at + length);
        }
        Ok(())
    };
    need(0, 13)?;
    let ts = f64::from_le_bytes(bytes[0..8].try_into()?);
    let flags = bytes[8];
    let uri_length = u32::from_le_bytes(bytes[9..13].try_into()?) as usize;
    need(13, uri_length)?;
    let uri = String::from_utf8_lossy(&bytes[13..13 + uri_length]).into_owned();
    let mut at = 13 + uri_length;
    let mut info = FileInfo { ts, uri, ..Default::default() };
    if flags & HAS_SHA256 != 0 {
        need(at, 2)?;
        let length = u16::from_le_bytes(bytes[at..at + 2].try_into()?) as usize;
        need(at + 2, length)?;
        info.sha256 = Some(String::from_utf8_lossy(&bytes[at + 2..at + 2 + length]).into_owned());
        at += 2 + length;
    }
    if flags & HAS_MTIME != 0 {
        need(at, 8)?;
        info.mtime = Some(f64::from_le_bytes(bytes[at..at + 8].try_into()?));
        at += 8;
    }
    if flags & HAS_CONTENT != 0 {
        info.content = Some(bytes[at..].to_vec());
    }
    Ok(info)
}

/// `dimos/go2/lidar/hardware_file_response/files.FileInfo` → go2/lidar, the top level's → "", anything else → None.
pub fn namespace_of_key(key: &str) -> Option<String> {
    let rest = key.strip_prefix("dimos/")?.strip_suffix("hardware_file_response/files.FileInfo")?;
    if rest.is_empty() {
        return Some(String::new());
    }
    Some(rest.strip_suffix('/')?.to_string())
}

fn under(namespace: &str, name: &str) -> String {
    if namespace.is_empty() { format!("dimos/{name}/{FILE_INFO_TYPE}") } else { format!("dimos/{namespace}/{name}/{FILE_INFO_TYPE}") }
}

/// where the module in `namespace` takes requests ("" = the top level)
pub fn request_key(namespace: &str) -> String {
    under(namespace, "hardware_file_request")
}

pub fn response_key(namespace: &str) -> String {
    under(namespace, "hardware_file_response")
}

/// The recording topic a module's answers are written under (`/go2/hardware_file_response`).
pub fn response_topic(namespace: &str) -> String {
    if namespace.is_empty() { "/hardware_file_response".into() } else { format!("/{namespace}/hardware_file_response") }
}

/// The namespaces a frame could be a module's frame in, innermost first: `a/b/link` → a/b, a, "".
pub fn frame_prefixes(frame: &str) -> Vec<String> {
    let parts: Vec<&str> = frame.split('/').filter(|part| !part.is_empty()).collect();
    let mut prefixes: Vec<String> = (1..parts.len()).rev().map(|count| parts[..count].join("/")).collect();
    prefixes.push(String::new());
    prefixes
}

/// Every asset a USD layer names (`@path@`), with the hash its `assetInfo` gives it (`string version = "sha256:..."`).
pub fn usd_assets(text: &str) -> BTreeMap<String, Option<String>> {
    let mut assets: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut rest = text;
    while let Some(start) = rest.find('@') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('@') else { break };
        let path = &after[..end];
        if !path.is_empty() && !path.contains('\n') {
            assets.entry(path.to_string()).or_insert(None);
        }
        rest = &after[end + 1..];
    }
    // assetInfo = { asset identifier = @path@  string version = "sha256:..." }
    let mut rest = text;
    while let Some(start) = rest.find("assetInfo") {
        let block = &rest[start..];
        let Some(close) = block.find('}') else { break };
        let block = &block[..close];
        let path = block.split('@').nth(1);
        let version = block.find("version").and_then(|at| block[at..].split('"').nth(1));
        if let (Some(path), Some(version)) = (path, version) {
            if version.starts_with("sha256:") {
                assets.insert(path.to_string(), Some(version.to_string()));
            }
        }
        rest = &rest[start + close..];
    }
    assets
}

/// What's known of one module: each file it served or announced, by uri, with its hash.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Module {
    pub files: BTreeMap<String, String>,
}

pub struct HardwareCache {
    dir: PathBuf,
    modules: Mutex<BTreeMap<String, Module>>,
}

/// `sha256:<hex>` → `<hex>`, refusing anything that isn't plain hex (it names a file on disk).
fn hex_of(sha256: &str) -> Option<&str> {
    let hex = sha256.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(hex)
}

impl HardwareCache {
    pub fn new(dir: PathBuf) -> Self {
        HardwareCache { dir, modules: Mutex::default() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_of(&self, sha256: &str) -> Option<PathBuf> {
        hex_of(sha256).map(|hex| self.dir.join(hex))
    }

    /// The bytes kept under `sha256`.
    pub fn bytes(&self, sha256: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path_of(sha256)?).ok()
    }

    pub fn has(&self, sha256: &str) -> bool {
        self.path_of(sha256).is_some_and(|path| path.exists())
    }

    /// A response heard on `key`: its bytes kept by hash, its name and hash remembered for the module. Returns the
    /// module's namespace and the FileInfo when it was a hardware_file_response.
    pub fn heard(&self, key: &str, payload: &[u8]) -> Option<(String, FileInfo)> {
        let namespace = namespace_of_key(key)?;
        let info = decode_file_info(payload).ok()?;
        let sha256 = info.sha256.clone()?;
        if let (Some(content), Some(path)) = (&info.content, self.path_of(&sha256)) {
            if !path.exists() {
                let _ = std::fs::create_dir_all(&self.dir);
                // written aside and renamed, so a reader never sees half a file
                let partial = path.with_extension("partial");
                if std::fs::write(&partial, content).is_ok() {
                    let _ = std::fs::rename(&partial, &path);
                }
            }
        }
        self.modules.lock().unwrap().entry(namespace.clone()).or_default().files.insert(info.uri.clone(), sha256);
        Some((namespace, info))
    }

    pub fn modules(&self) -> BTreeMap<String, Module> {
        self.modules.lock().unwrap().clone()
    }

    /// A module's file as its module answers it (content from the cache), or None when its bytes aren't here.
    pub fn response(&self, namespace: &str, uri: &str) -> Option<Vec<u8>> {
        let sha256 = self.modules.lock().unwrap().get(namespace)?.files.get(uri)?.clone();
        let content = self.bytes(&sha256)?;
        Some(encode_file_info(&FileInfo { ts: crate::record::now_nanos() as f64 / 1e9, uri: uri.into(), sha256: Some(sha256), mtime: None, content: Some(content) }))
    }

    /// The files of `namespace` a recording should hold and this cache can't give: its hardware.usda when it isn't
    /// here, else each asset the USD names whose bytes aren't. (Asked for with no hash: a hash would get a header back.)
    pub fn missing(&self, namespace: &str) -> Vec<String> {
        let module = self.modules.lock().unwrap().get(namespace).cloned().unwrap_or_default();
        let Some(usd) = module.files.get(HARDWARE_USD).and_then(|sha256| self.bytes(sha256)) else {
            return vec![HARDWARE_USD.to_string()];
        };
        usd_assets(&String::from_utf8_lossy(&usd))
            .into_iter()
            .filter(|(uri, hash)| !hash.clone().or_else(|| module.files.get(uri).cloned()).is_some_and(|sha256| self.has(&sha256)))
            .map(|(uri, _)| uri)
            .collect()
    }

    /// The namespaces `frames` could hold modules in that this cache knows nothing of.
    pub fn unknown_namespaces<'a>(&self, frames: impl IntoIterator<Item = &'a String>) -> BTreeSet<String> {
        let modules = self.modules.lock().unwrap();
        frames.into_iter().flat_map(|frame| frame_prefixes(frame)).filter(|namespace| !modules.contains_key(namespace)).collect()
    }
}

/// Every FileInfo a recording holds on a hardware_file_response channel, into the cache; returns how many.
pub fn load_mcap(cache: &HardwareCache, path: &Path) -> Result<usize> {
    let bytes = std::fs::read(path)?;
    let mut loaded = 0;
    for message in mcap::MessageStream::new(&bytes)? {
        let message = message?;
        let channel = &message.channel;
        let is_file_info = channel.metadata.get("lcm_type").is_some_and(|kind| kind == FILE_INFO_TYPE);
        let Some(topic) = channel.topic.strip_suffix("hardware_file_response") else {
            continue;
        };
        if !is_file_info {
            continue;
        }
        let namespace = topic.trim_matches('/');
        if cache.heard(&response_key(namespace), &message.data).is_some() {
            loaded += 1;
        }
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_USD: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("controller_hardware_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn usd() -> String {
        format!(
            "#usda 1.0\ndef Xform \"go2\"\n{{\n    def Mesh \"visual\" (\n        assetInfo = {{\n            asset identifier = @go2/base/body.stl@\n            string version = \"{HASH_A}\"\n        }}\n        prepend references = @go2/base/body.stl@\n    )\n    {{\n    }}\n    def Mesh \"other\" ( prepend references = @go2/head.usda@ ) {{ }}\n}}\n"
        )
    }

    /// FileInfo as dimos's FileInfo.py encodes it (the frontend's fileInfo.test.ts holds the same bytes).
    #[test]
    fn file_info_reads_and_writes_dimos_s_layout() {
        let info = FileInfo { ts: 1.5, uri: "a/b.stl".into(), sha256: Some(HASH_A.into()), mtime: Some(2.0), content: Some(vec![1, 2, 3]) };
        let bytes = encode_file_info(&info);
        assert_eq!(&bytes[..9], &[0, 0, 0, 0, 0, 0, 0xf8, 0x3f, 7]);
        assert_eq!(decode_file_info(&bytes).unwrap(), info);
        let header = FileInfo { ts: 0.0, uri: "x".into(), ..Default::default() };
        assert_eq!(decode_file_info(&encode_file_info(&header)).unwrap(), header);
        assert!(decode_file_info(&bytes[..12]).is_err());
        // an empty file is content, not a header
        let empty = FileInfo { content: Some(vec![]), ..header };
        assert_eq!(decode_file_info(&encode_file_info(&empty)).unwrap().content, Some(vec![]));
    }

    #[test]
    fn keys_namespaces_and_frame_prefixes() {
        assert_eq!(namespace_of_key("dimos/go2/lidar/hardware_file_response/files.FileInfo"), Some("go2/lidar".into()));
        assert_eq!(namespace_of_key("dimos/hardware_file_response/files.FileInfo"), Some("".into()));
        assert_eq!(namespace_of_key("dimos/go2/file_info/files.File"), None);
        assert_eq!(namespace_of_key("dimos/xhardware_file_response/files.FileInfo"), None);
        assert_eq!(request_key("go2"), "dimos/go2/hardware_file_request/files.FileInfo");
        assert_eq!(request_key(""), "dimos/hardware_file_request/files.FileInfo");
        assert_eq!(response_topic("go2/lidar"), "/go2/lidar/hardware_file_response");
        assert_eq!(frame_prefixes("a/b/link"), vec!["a/b".to_string(), "a".into(), "".into()]);
        assert_eq!(frame_prefixes("base_link"), vec!["".to_string()]);
    }

    #[test]
    fn a_usd_s_assets_with_their_hashes() {
        let assets = usd_assets(&usd());
        assert_eq!(assets.get("go2/base/body.stl"), Some(&Some(HASH_A.to_string())));
        assert_eq!(assets.get("go2/head.usda"), Some(&None));
        assert_eq!(assets.len(), 2);
    }

    #[test]
    fn responses_fill_the_cache_by_hash_and_say_what_a_recording_still_needs() {
        let cache = HardwareCache::new(temp_dir("fill"));
        assert_eq!(cache.missing("go2"), vec![HARDWARE_USD.to_string()], "nothing yet: the USD itself");
        let usd = usd().into_bytes();
        let answer = |uri: &str, sha256: &str, content: Option<Vec<u8>>| encode_file_info(&FileInfo { ts: 1.0, uri: uri.into(), sha256: Some(sha256.into()), mtime: None, content });
        assert!(cache.heard("dimos/go2/hardware_file_response/files.FileInfo", &answer(HARDWARE_USD, HASH_USD, Some(usd.clone()))).is_some());
        assert_eq!(cache.bytes(HASH_USD), Some(usd));
        assert_eq!(cache.missing("go2"), vec!["go2/base/body.stl".to_string(), "go2/head.usda".to_string()]);
        // a header only (an asker that had it): the name is remembered, nothing is stored
        cache.heard("dimos/go2/hardware_file_response/files.FileInfo", &answer("go2/head.usda", HASH_B, None));
        assert!(!cache.has(HASH_B));
        cache.heard("dimos/go2/hardware_file_response/files.FileInfo", &answer("go2/base/body.stl", HASH_A, Some(vec![9; 10])));
        assert_eq!(cache.missing("go2"), vec!["go2/head.usda".to_string()], "named (by a header) but its bytes never came");
        // what a recording writes: the module's answer, from the cache
        let written = decode_file_info(&cache.response("go2", "go2/base/body.stl").unwrap()).unwrap();
        assert_eq!((written.uri.as_str(), written.sha256.as_deref(), written.content), ("go2/base/body.stl", Some(HASH_A), Some(vec![9; 10])));
        assert!(cache.response("go2", "go2/head.usda").is_none());
        // a hash that isn't one never names a file
        cache.heard("dimos/go2/hardware_file_response/files.FileInfo", &answer("evil", "sha256:../../x", Some(vec![1])));
        assert!(!cache.has("sha256:../../x"));
        let frames = vec!["go2/base_link".to_string(), "spot/body".to_string()];
        assert_eq!(cache.unknown_namespaces(&frames), BTreeSet::from(["".to_string(), "spot".to_string()]));
        let _ = std::fs::remove_dir_all(cache.dir());
    }
}
