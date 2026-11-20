//! The **per-sample** path for `foxglove_msgs/CompressedVideo` data: one coded picture to a picture for the video
//! encoder, decoded with a decoder of its own.
//!
//! Each sample is decoded alone (the gateway decodes only the samples it sends and shares the result between
//! frontends), so a sample must be a keyframe carrying the bytes a decoder starts from: a stream with predicted frames,
//! or one whose headers are sent once, can't play this way — about one frame a second on a camera with a keyframe a
//! second. That is what [`video_stream`](super::video_stream) exists to fix, and this path remains for the encodings
//! and channels that do not need it.
//!
//! Reading the bytes themselves is [`bitstream`](super::bitstream)'s, for all three codecs; what is left here is the
//! per-sample rule and the shared I420 plane copy the decoders hand their pictures over with.

use super::bitstream;
use anyhow::{Result, ensure};
use crate::video::VideoImage;

/// The picture in one coded unit of `format` (`h264`, `h265`, `av1`).
pub fn to_video(data: &[u8], format: &str) -> Result<VideoImage> {
    let bitstream = bitstream::by_name(format)?;
    bitstream::check_decodable_alone(bitstream, data)?;
    bitstream.decode_alone(data)
}

/// An I420 picture from 8-bit 4:2:0 planes with row strides, cropped to even sizes (what I420 takes).
pub(crate) fn i420_from_planes(width: usize, height: usize, planes: [(&[u8], usize); 3]) -> Result<VideoImage> {
    let (even_width, even_height) = (width & !1, height & !1);
    ensure!(even_width > 0 && even_height > 0, "empty picture ({width}x{height})");
    let mut data = Vec::with_capacity(even_width * even_height * 3 / 2);
    for (index, (plane, stride)) in planes.into_iter().enumerate() {
        let (columns, rows) = if index == 0 { (even_width, even_height) } else { (even_width / 2, even_height / 2) };
        ensure!(stride >= columns && plane.len() >= stride * (rows - 1) + columns, "plane {index} too small for {width}x{height}");
        for row in 0..rows {
            data.extend_from_slice(&plane[row * stride..row * stride + columns]);
        }
    }
    VideoImage::i420(even_width as u32, even_height as u32, data)
}

