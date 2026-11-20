//! Snapshots: pictures of the 3D view (the page's) or a camera (taken here from its topic, `camera`), kept as PNGs in
//! `snapshots/` in the app's data dir, so every page's gallery shows the same ones. Each file is named
//! `<unix ms>_<view>_<source>.png`, which is all there is to know about it. A change is an
//! `{type: "snapshots", snapshots}` event on the page event stream.
use std::path::{Path as FilePath, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Path, Query, State as Extract};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::json;

use crate::api::Api;

/// the biggest picture a page may send (a 4K view as PNG is a few MB; axum's default limit is 2 MB)
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Serialize, Debug, PartialEq)]
pub struct Snapshot {
    pub name: String,
    /// what was captured: "3d" or "camera"
    pub view: String,
    /// the camera topic (or "3d"), as far as a file name keeps it
    pub source: String,
    /// unix ms
    pub created: u64,
    pub bytes: u64,
}

fn error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

/// Letters, digits, `.` and `-` kept, runs of anything else one `-` (`_` separates the name's parts).
fn clean(text: &str) -> String {
    let mut out = String::new();
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || character == '.' || character == '-' {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(80).collect()
}

/// A file name's parts, or None for a file that isn't a snapshot.
fn parse(name: &str) -> Option<(u64, String, String)> {
    let stem = name.strip_suffix(".png")?;
    let mut parts = stem.splitn(3, '_');
    let created = parts.next()?.parse().ok()?;
    let view = parts.next()?.to_string();
    let source = parts.next().unwrap_or("").to_string();
    Some((created, view, source))
}

/// The snapshot file `name` names in `dir`: a plain snapshot file name only (no paths).
fn resolve(dir: &FilePath, name: &str) -> Result<PathBuf, Response> {
    let plain = !name.contains(['/', '\\']) && name != "." && name != "..";
    if !plain || parse(name).is_none() {
        return Err(error(StatusCode::BAD_REQUEST, "not a snapshot name (as GET api/snapshots lists them)"));
    }
    Ok(dir.join(name))
}

/// Every snapshot in `dir`, newest first.
pub fn list_in(dir: &FilePath) -> Vec<Snapshot> {
    let mut snapshots: Vec<Snapshot> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (created, view, source) = parse(&name)?;
            let bytes = entry.metadata().ok()?.len();
            Some(Snapshot { name, view, source, created, bytes })
        })
        .collect();
    snapshots.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| b.name.cmp(&a.name)));
    snapshots
}

fn changed(api: &Api) -> Vec<Snapshot> {
    let snapshots = list_in(&api.snapshots);
    api.annotations.broadcast(json!({ "type": "snapshots", "snapshots": snapshots }));
    snapshots
}

pub async fn list(Extract(api): Extract<Api>) -> Response {
    Json(json!({ "snapshots": list_in(&api.snapshots) })).into_response()
}

pub async fn save(Extract(api): Extract<Api>, Query(query): Query<std::collections::HashMap<String, String>>, body: Bytes) -> Response {
    if !body.starts_with(PNG_SIGNATURE) {
        return error(StatusCode::BAD_REQUEST, "the body must be a PNG image");
    }
    let view = query.get("view").map(String::as_str).unwrap_or("3d");
    store(&api, view, query.get("source").map(String::as_str).unwrap_or(""), &body)
}

/// Saves `png` to the gallery under a fresh name and tells every page.
fn store(api: &Api, view: &str, source: &str, png: &[u8]) -> Response {
    let view = match clean(view) {
        view if view.is_empty() => "3d".to_string(),
        view => view.to_lowercase(),
    };
    let source = clean(source);
    if let Err(problem) = std::fs::create_dir_all(api.snapshots.as_path()) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, format!("couldn't make {}: {problem}", api.snapshots.display()));
    }
    let mut created = SystemTime::now().duration_since(UNIX_EPOCH).map(|age| age.as_millis() as u64).unwrap_or(0);
    // two in the same millisecond: the second takes the next free one
    let (name, file) = loop {
        let name = format!("{created}_{view}_{source}.png");
        match std::fs::OpenOptions::new().write(true).create_new(true).open(api.snapshots.join(&name)) {
            Ok(file) => break (name, file),
            Err(problem) if problem.kind() == std::io::ErrorKind::AlreadyExists => created += 1,
            Err(problem) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("couldn't save {name}: {problem}")),
        }
    };
    if let Err(problem) = std::io::Write::write_all(&mut &file, png) {
        let _ = std::fs::remove_file(api.snapshots.join(&name));
        return error(StatusCode::INTERNAL_SERVER_ERROR, format!("couldn't save {name}: {problem}"));
    }
    let snapshots = changed(api);
    let snapshot = snapshots.iter().find(|snapshot| snapshot.name == name);
    Json(json!({ "snapshot": snapshot, "snapshots": snapshots })).into_response()
}

/// how long a camera snapshot waits for a picture: a video camera's next keyframe can be a few seconds off
const CAMERA_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// A camera's next picture, taken from its topic here at full quality (not the page's video of it, which is scaled and
/// re-encoded), as a PNG in the gallery. A video camera (CompressedVideo: H.264, H.265, AV1) gives its next keyframe.
pub async fn camera(Extract(api): Extract<Api>, Query(query): Query<std::collections::HashMap<String, String>>) -> Response {
    let key = query.get("topic").map(String::as_str).unwrap_or("");
    let Some((topic, msg_type)) = crate::recorder::split_key(key) else {
        return error(StatusCode::BAD_REQUEST, "topic must be a camera's zenoh key, dimos/<topic>/<type>");
    };
    if ![crate::msgs::IMAGE_TYPE, crate::msgs::COMPRESSED_IMAGE_TYPE, crate::msgs::COMPRESSED_VIDEO_TYPE].contains(&msg_type.as_str()) {
        return error(StatusCode::BAD_REQUEST, format!("{msg_type} isn't a camera type (Image, CompressedImage, CompressedVideo)"));
    }
    let session = match api.recorder.session().await {
        Ok(session) => session,
        Err(problem) => return error(StatusCode::SERVICE_UNAVAILABLE, format!("{problem:#}")),
    };
    let subscriber = match session.declare_subscriber(key.to_string()).await {
        Ok(subscriber) => subscriber,
        Err(problem) => return error(StatusCode::SERVICE_UNAVAILABLE, format!("zenoh: {problem}")),
    };
    let mut still = crate::video::Still::default();
    let mut last_problem = None;
    let waited = tokio::time::timeout(CAMERA_WAIT, async {
        while let Ok(sample) = subscriber.recv_async().await {
            let payload = sample.payload().to_bytes();
            // decoding is CPU work (a 4K keyframe is tens of ms): off the async threads
            let (decoded, back) = tokio::task::spawn_blocking({
                let (msg_type, payload) = (msg_type.clone(), payload.to_vec());
                move || {
                    let decoded = picture_png(&msg_type, &payload, &mut still);
                    (decoded, still)
                }
            })
            .await
            .expect("the decode task panicked");
            still = back;
            match decoded {
                Ok(Some(png)) => return Some(png),
                Ok(None) => {}
                Err(problem) => last_problem = Some(format!("{problem:#}")),
            }
        }
        None
    })
    .await;
    match waited {
        Ok(Some(png)) => store(&api, "camera", query.get("source").map(String::as_str).unwrap_or(&topic), &png),
        _ => error(
            StatusCode::GATEWAY_TIMEOUT,
            match last_problem {
                Some(problem) => format!("no picture of {topic} decoded in {} s: {problem}", CAMERA_WAIT.as_secs()),
                None => format!("no picture from {topic} in {} s (is it publishing?)", CAMERA_WAIT.as_secs()),
            },
        ),
    }
}

/// One camera message as a PNG; None for a video sample that can't start a decode (not a keyframe).
fn picture_png(msg_type: &str, payload: &[u8], still: &mut crate::video::Still) -> anyhow::Result<Option<Vec<u8>>> {
    use crate::msgs::{ImageMessage, RawImage};
    let rgb = |width: u32, height: u32, data: Vec<u8>| RawImage {
        header: crate::msgs::Header { stamp_sec: 0, stamp_nsec: 0, frame_id: String::new() },
        width: width as usize,
        height: height as usize,
        step: width as usize * 3,
        is_bigendian: 0,
        encoding: "rgb8".into(),
        data,
    };
    let as_png = |image: &RawImage| {
        crate::image::compress(image, crate::image::ImageFormat::Png)
            .map(|png| png.data)
            .ok_or_else(|| anyhow::anyhow!("a {} picture can't be a PNG", image.encoding))
    };
    let from_compressed = |data: &[u8]| -> anyhow::Result<Vec<u8>> {
        if data.starts_with(PNG_SIGNATURE) {
            return Ok(data.to_vec());
        }
        let (width, height, pixels) = jpeg_rgb(data)?;
        as_png(&rgb(width, height, pixels))
    };
    if msg_type == crate::msgs::COMPRESSED_VIDEO_TYPE {
        let video = crate::msgs::decode_compressed_video(payload)?;
        let Some(picture) = still.push(&video.data, &video.format)? else {
            return Ok(None);
        };
        return as_png(&rgb(picture.width(), picture.height(), picture.to_rgb())).map(Some);
    }
    match crate::msgs::decode_any_image(msg_type, payload)? {
        // dimos's JpegLcmTransport: an Image whose data is a whole JPEG
        ImageMessage::Raw(image) if crate::image::container_format(&image).is_some() => from_compressed(&image.data).map(Some),
        ImageMessage::Raw(image) => as_png(&image).map(Some),
        ImageMessage::Compressed(image) => from_compressed(&image.data).map(Some),
    }
}

fn jpeg_rgb(data: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    use zune_jpeg::zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(data), options);
    let pixels = decoder.decode().map_err(|problem| anyhow::anyhow!("jpeg: {problem:?}"))?;
    let info = decoder.info().ok_or_else(|| anyhow::anyhow!("jpeg: no header"))?;
    Ok((info.width as u32, info.height as u32, pixels))
}

pub async fn get(Extract(api): Extract<Api>, Path(name): Path<String>) -> Response {
    let path = match resolve(&api.snapshots, &name) {
        Ok(path) => path,
        Err(response) => return response,
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], bytes).into_response(),
        Err(_) => error(StatusCode::NOT_FOUND, "no such snapshot"),
    }
}

pub async fn delete(Extract(api): Extract<Api>, Path(name): Path<String>) -> Response {
    let path = match resolve(&api.snapshots, &name) {
        Ok(path) => path,
        Err(response) => return response,
    };
    if std::fs::remove_file(&path).is_err() {
        return error(StatusCode::NOT_FOUND, "no such snapshot");
    }
    let snapshots = changed(&api);
    Json(json!({ "ok": true, "removed": name, "snapshots": snapshots })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A foxglove_msgs/CompressedVideo LCM message, as dimos publishes it.
    fn compressed_video(data: &[u8], format: &str) -> Vec<u8> {
        let lcm_string = |text: &str| [(text.len() as i32 + 1).to_be_bytes().as_slice(), text.as_bytes(), &[0]].concat();
        let length = (data.len() as i32).to_be_bytes();
        [&crate::msgs::COMPRESSED_VIDEO_FINGERPRINT[..], &length, &[0; 8], &lcm_string("camera"), data, &lcm_string(format)].concat()
    }

    #[test]
    fn a_video_camera_gives_its_keyframe_as_a_png() {
        let keyframe = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/src/video/fixtures/pattern.h264")).unwrap();
        let png = picture_png(crate::msgs::COMPRESSED_VIDEO_TYPE, &compressed_video(&keyframe, "h264"), &mut Default::default()).unwrap().unwrap();
        assert!(png.starts_with(PNG_SIGNATURE));
        let info = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap().info().clone();
        assert_eq!((info.width, info.height, info.color_type), (320, 240, png::ColorType::Rgb));
    }

    #[test]
    fn names_carry_time_view_and_source() {
        assert_eq!(clean("dimos/head/left/image/sensor_msgs.Image"), "dimos-head-left-image-sensor-msgs.Image");
        assert_eq!(parse("1761400000000_camera_dimos-color-image.png"), Some((1761400000000, "camera".into(), "dimos-color-image".into())));
        assert_eq!(parse("1761400000000_3d_.png"), Some((1761400000000, "3d".into(), "".into())));
        assert_eq!(parse("notes.png"), None);
        assert_eq!(parse("1761400000000_3d_x.jpg"), None);
        let dir = std::env::temp_dir();
        assert!(resolve(&dir, "../1_3d_.png").is_err());
        assert!(resolve(&dir, "settings.json").is_err());
        assert_eq!(resolve(&dir, "1_3d_.png").ok(), Some(dir.join("1_3d_.png")));
    }
}
