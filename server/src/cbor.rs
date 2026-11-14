//! dimos's RPC payloads since dimos#4821 (dimos/protocol/encode/cbor.py): CBOR (RFC 8949) whose tags carry the Python
//! types JSON lacks. A reader for the replies, into the JSON this server's API has always given (an object is its
//! fields plus `"__class__"`, its class's short name; an enum `{"__class__", "name", "value"}`; a numpy scalar its
//! number; NaN and infinities null), and a writer for the requests (`(args, kwargs)` of plain values and dimos
//! messages), for what manipulation.rs's calls carry. A dimos message travels as its class and LCM bytes (tag 4047),
//! read and written here as its own lcm_decode / lcm_encode do. Nothing is executed: a class is only a name.
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value as Json};

use crate::msgs::{self, Reader};

// dimos/protocol/encode/cbor.py's tags (the ones these replies use, and what else maps to JSON plainly)
const TAG_TUPLE: u64 = 4040;
const TAG_NAMEDTUPLE: u64 = 4041;
const TAG_SET: u64 = 4042;
const TAG_FROZENSET: u64 = 4043;
const TAG_NDARRAY: u64 = 4044;
const TAG_NPSCALAR: u64 = 4045;
const TAG_ENUM: u64 = 4046;
const TAG_DIMOSMSG: u64 = 4047;
const TAG_DATACLASS: u64 = 4048;
const TAG_PYDANTIC: u64 = 4049;
const TAG_PATH: u64 = 4050;
const TAG_CLASS: u64 = 4051;
const TAG_FUNCTION: u64 = 4052;
const TAG_DICT: u64 = 4056;
// RFC 8949's bignums, which cbor2 writes for an int past 64 bits
const TAG_BIGNUM: u64 = 2;
const TAG_NEGATIVE_BIGNUM: u64 = 3;

/// The dimos messages these RPCs carry, by their class (`"module:qualname"`, as dimos's encoder names it).
const JOINT_STATE: &str = "dimos.msgs.sensor_msgs.JointState:JointState";
const POSE_STAMPED: &str = "dimos.msgs.geometry_msgs.PoseStamped:PoseStamped";

// the fingerprints of dimos's own (not lcm-gen) trajectory messages, and of geometry_msgs.Pose
const POSE_FINGERPRINT: [u8; 8] = [0x24, 0x56, 0x34, 0xae, 0x2a, 0xb1, 0x7b, 0x76];
const JOINT_TRAJECTORY_FINGERPRINT: [u8; 8] = [0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x70, 0x81, 0x92];
const TRAJECTORY_STATUS_FINGERPRINT: [u8; 8] = [0x3c, 0x4d, 0x5e, 0x6f, 0x70, 0x81, 0x92, 0xa3];

const MAX_DEPTH: usize = 200;

/// A CBOR data item.
#[derive(Debug, Clone, PartialEq)]
enum Cbor {
    /// major types 0 and 1: -2^64 ..= 2^64 - 1
    Int(i128),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
    Tag(u64, Box<Cbor>),
    Float(f64),
    Bool(bool),
    /// null, and undefined
    Null,
}

struct Decoder<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Decoder<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(count).filter(|end| *end <= self.data.len());
        let end = end.ok_or_else(|| anyhow!("cbor ends early at byte {}", self.at))?;
        let bytes = &self.data[self.at..end];
        self.at = end;
        Ok(bytes)
    }

    fn argument(&mut self, info: u8) -> Result<u64> {
        Ok(match info {
            0..=23 => info.into(),
            24 => self.take(1)?[0].into(),
            25 => u16::from_be_bytes(self.take(2)?.try_into()?).into(),
            26 => u32::from_be_bytes(self.take(4)?.try_into()?).into(),
            27 => u64::from_be_bytes(self.take(8)?.try_into()?),
            // dimos's encoder (cbor2.dumps) writes every length up front
            31 => bail!("cbor: an indefinite length at byte {}", self.at - 1),
            _ => bail!("cbor: reserved additional information {info} at byte {}", self.at - 1),
        })
    }

    /// A count of bytes or items: each takes a byte at least, so one past the bytes left is a broken payload.
    fn count(&mut self, info: u8) -> Result<usize> {
        let count = self.argument(info)?;
        usize::try_from(count)
            .ok()
            .filter(|count| *count <= self.data.len() - self.at)
            .ok_or_else(|| anyhow!("cbor: a length of {count} with {} bytes left", self.data.len() - self.at))
    }

    fn item(&mut self, depth: usize) -> Result<Cbor> {
        if depth > MAX_DEPTH {
            bail!("cbor: nested too deeply");
        }
        let initial = self.take(1)?[0];
        let (major, info) = (initial >> 5, initial & 0x1f);
        Ok(match major {
            0 => Cbor::Int(self.argument(info)?.into()),
            1 => Cbor::Int(-1 - i128::from(self.argument(info)?)),
            2 => {
                let count = self.count(info)?;
                Cbor::Bytes(self.take(count)?.to_vec())
            }
            3 => {
                let count = self.count(info)?;
                Cbor::Text(String::from_utf8(self.take(count)?.to_vec()).map_err(|_| anyhow!("cbor: a text string that isn't UTF-8"))?)
            }
            4 => {
                let count = self.count(info)?;
                Cbor::Array((0..count).map(|_| self.item(depth + 1)).collect::<Result<_>>()?)
            }
            5 => {
                let count = self.count(info)?;
                Cbor::Map((0..count).map(|_| Ok((self.item(depth + 1)?, self.item(depth + 1)?))).collect::<Result<_>>()?)
            }
            6 => {
                let tag = self.argument(info)?;
                Cbor::Tag(tag, Box::new(self.item(depth + 1)?))
            }
            _ => match info {
                20 => Cbor::Bool(false),
                21 => Cbor::Bool(true),
                22 | 23 => Cbor::Null,
                25 => Cbor::Float(half(u16::from_be_bytes(self.take(2)?.try_into()?))),
                26 => Cbor::Float(f32::from_be_bytes(self.take(4)?.try_into()?).into()),
                27 => Cbor::Float(f64::from_be_bytes(self.take(8)?.try_into()?)),
                _ => bail!("cbor: simple value {info} at byte {}", self.at - 1),
            },
        })
    }
}

/// An IEEE 754 half-precision float (cbor2 writes NaN and the infinities as one), as RFC 8949's Appendix D reads it.
fn half(bits: u16) -> f64 {
    let exponent = i32::from((bits >> 10) & 0x1f);
    let mantissa = f64::from(bits & 0x3ff);
    let magnitude = match exponent {
        0 => mantissa * 2f64.powi(-24),
        31 if mantissa == 0.0 => f64::INFINITY,
        31 => f64::NAN,
        _ => (mantissa + 1024.0) * 2f64.powi(exponent - 25),
    };
    if bits & 0x8000 != 0 {
        -magnitude
    } else {
        magnitude
    }
}

/// Decode one CBOR item (the whole payload).
fn loads(data: &[u8]) -> Result<Cbor> {
    let mut decoder = Decoder { data, at: 0 };
    let item = decoder.item(0)?;
    if decoder.at != data.len() {
        bail!("cbor: {} bytes after the value", data.len() - decoder.at);
    }
    Ok(item)
}

/// A reply (or an error reply's serialized exception) as JSON.
pub fn decode(data: &[u8]) -> Result<Json> {
    to_json(&loads(data)?, 0)
}

/// `"module:qualname"`'s last name, as the API's `"__class__"` gives a class.
fn short(class: &str) -> &str {
    class.rsplit([':', '.']).next().unwrap_or(class)
}

fn int_json(number: i128) -> Json {
    if let Ok(number) = i64::try_from(number) {
        json!(number)
    } else if let Ok(number) = u64::try_from(number) {
        json!(number)
    } else {
        json!(number as f64)
    }
}

/// A key as a JSON object key: a string as it is, anything else by its JSON text.
fn key_text(key: &Cbor, depth: usize) -> Result<String> {
    Ok(match key {
        Cbor::Text(text) => text.clone(),
        other => to_json(other, depth + 1)?.to_string(),
    })
}

/// A tag's `[a, b, ...]` content.
fn parts<const N: usize>(tag: u64, value: &Cbor) -> Result<&[Cbor; N]> {
    match value {
        Cbor::Array(items) => items.as_slice().try_into().map_err(|_| anyhow!("cbor: tag {tag} holds {} items, not {N}", items.len())),
        _ => bail!("cbor: tag {tag} doesn't hold an array"),
    }
}

fn text(tag: u64, value: &Cbor) -> Result<&str> {
    match value {
        Cbor::Text(text) => Ok(text),
        _ => bail!("cbor: tag {tag} names its class with something other than a string"),
    }
}

fn items(tag: u64, value: &Cbor) -> Result<&[Cbor]> {
    match value {
        Cbor::Array(items) => Ok(items),
        _ => bail!("cbor: tag {tag} doesn't hold an array"),
    }
}

/// An object: `"__class__"` and its fields (a map with string keys).
fn object(class: &str, fields: &[&Cbor], depth: usize) -> Result<Json> {
    let mut object = Map::new();
    object.insert("__class__".into(), json!(short(class)));
    for field in fields {
        let Cbor::Map(pairs) = field else {
            bail!("cbor: {class}'s fields aren't a map");
        };
        for (key, value) in pairs {
            object.insert(key_text(key, depth)?, to_json(value, depth + 1)?);
        }
    }
    Ok(Json::Object(object))
}

/// The value as the API's JSON.
fn to_json(value: &Cbor, depth: usize) -> Result<Json> {
    if depth > MAX_DEPTH {
        bail!("cbor: nested too deeply");
    }
    let all = |items: &[Cbor]| items.iter().map(|item| to_json(item, depth + 1)).collect::<Result<Vec<_>>>().map(Json::Array);
    Ok(match value {
        Cbor::Null => Json::Null,
        Cbor::Bool(flag) => json!(flag),
        Cbor::Int(number) => int_json(*number),
        Cbor::Float(number) => json!(number),
        Cbor::Text(text) => json!(text),
        Cbor::Bytes(bytes) => json!({ "__bytes__": bytes.len() }),
        Cbor::Array(items) => all(items)?,
        Cbor::Map(pairs) => Json::Object(pairs.iter().map(|(key, value)| Ok((key_text(key, depth)?, to_json(value, depth + 1)?))).collect::<Result<_>>()?),
        Cbor::Tag(tag, inner) => match *tag {
            TAG_TUPLE | TAG_SET | TAG_FROZENSET => all(items(*tag, inner)?)?,
            TAG_DATACLASS => {
                let [class, fields] = parts(*tag, inner)?;
                object(text(*tag, class)?, &[fields], depth)?
            }
            TAG_PYDANTIC => {
                // [class, fields, the names of the fields set, extra fields]
                let [class, fields, _, extra] = parts(*tag, inner)?;
                object(text(*tag, class)?, &[fields, extra], depth)?
            }
            TAG_ENUM => {
                let [class, member] = parts(*tag, inner)?;
                let class = short(text(*tag, class)?);
                json!({ "__class__": class, "name": enum_name(class, member), "value": to_json(member, depth + 1)? })
            }
            TAG_DIMOSMSG => {
                let [class, lcm] = parts(*tag, inner)?;
                let Cbor::Bytes(lcm) = lcm else {
                    bail!("cbor: a dimos message without its LCM bytes");
                };
                message(text(*tag, class)?, lcm)?
            }
            TAG_NAMEDTUPLE => {
                let [class, fields] = parts(*tag, inner)?;
                json!({ "__class__": short(text(*tag, class)?), "args": all(items(*tag, fields)?)? })
            }
            TAG_NPSCALAR => {
                let [dtype, raw] = parts(*tag, inner)?;
                numpy(text(*tag, dtype)?, raw, &[])?
            }
            TAG_NDARRAY => {
                let [dtype, shape, raw] = parts(*tag, inner)?;
                let shape = items(*tag, shape)?
                    .iter()
                    .map(|size| match size {
                        Cbor::Int(size) => usize::try_from(*size).map_err(|_| anyhow!("cbor: an array size of {size}")),
                        _ => bail!("cbor: an array shape that isn't sizes"),
                    })
                    .collect::<Result<Vec<_>>>()?;
                numpy(text(*tag, dtype)?, raw, &shape)?
            }
            TAG_PATH => to_json(inner, depth + 1)?,
            TAG_CLASS | TAG_FUNCTION => json!({ "__class__": text(*tag, inner)?.replacen(':', ".", 1) }),
            TAG_DICT => {
                let mut object = Map::new();
                for pair in items(*tag, inner)? {
                    let [key, value] = parts(*tag, pair)?;
                    object.insert(key_text(key, depth)?, to_json(value, depth + 1)?);
                }
                Json::Object(object)
            }
            TAG_BIGNUM | TAG_NEGATIVE_BIGNUM => {
                let Cbor::Bytes(bytes) = inner.as_ref() else {
                    bail!("cbor: a bignum that isn't bytes");
                };
                let magnitude = bytes.iter().fold(0f64, |total, byte| total * 256.0 + f64::from(*byte));
                json!(if *tag == TAG_BIGNUM { magnitude } else { -1.0 - magnitude })
            }
            // anything else these replies don't carry (a function, a type form, a custom codec's): its content
            _ => to_json(inner, depth + 1)?,
        },
    })
}

/// The name of a member of a dimos enum these RPCs return (CBOR sends an enum as its class and value only); null for
/// another enum. src/cbor_fixtures/enums.json (dimos's own members) is checked against this.
fn enum_name(class: &str, member: &Cbor) -> Option<&'static str> {
    let Cbor::Int(value) = member else {
        return None;
    };
    let (first, names): (i128, &[&str]) = match class {
        "OperationStatus" => (1, &["IDLE", "PLANNING", "HAS_PLAN", "EXECUTING"]),
        "PlanStatus" => (1, &["SUCCEEDED", "FAILED", "INVALID_TARGET", "AMBIGUOUS_GROUP", "NO_MOTION"]),
        "PlanningStatus" => (1, &["SUCCESS", "NO_SOLUTION", "TIMEOUT", "INVALID_START", "INVALID_GOAL", "COLLISION_AT_START", "COLLISION_AT_GOAL", "UNSUPPORTED"]),
        "CommandStatus" => (1, &["SUCCEEDED", "REJECTED", "FAILED"]),
        "ExecutionStatus" => (1, &["IDLE", "ACCEPTED", "REJECTED", "EXECUTING", "COMPLETED", "ABORTED", "FAULT", "TIMED_OUT", "NO_PLAN", "NO_EXECUTION", "UNCERTAIN"]),
        "TrajectoryState" => (0, &["IDLE", "EXECUTING", "COMPLETED", "ABORTED", "FAULT"]),
        "TrajectoryExecutionStatus" => (1, &["ACCEPTED", "NO_TRAJECTORY_TASK", "INVALID_TRAJECTORY", "START_STATE_UNAVAILABLE", "START_STATE_MISMATCH", "ALREADY_EXECUTING", "ESTOPPED"]),
        _ => return None,
    };
    names.get(usize::try_from(value - first).ok()?).copied()
}

/// One number of a numpy dtype (`dtype.str`: byte order, kind, size), None for a dtype that isn't a plain number.
fn numpy_number(dtype: &str, raw: &[u8]) -> Option<Json> {
    let (order, kind, size) = (dtype.as_bytes().first()?, dtype.as_bytes().get(1)?, dtype.get(2..)?.parse::<usize>().ok()?);
    let mut raw = raw.get(..size)?.to_vec();
    if *order == b'>' {
        raw.reverse();
    }
    Some(match (*kind, size) {
        (b'f', 8) => json!(f64::from_le_bytes(raw.try_into().ok()?)),
        (b'f', 4) => json!(f64::from(f32::from_le_bytes(raw.try_into().ok()?))),
        (b'f', 2) => json!(half(u16::from_le_bytes(raw.try_into().ok()?))),
        (b'i', 8) => json!(i64::from_le_bytes(raw.try_into().ok()?)),
        (b'i', 4) => json!(i32::from_le_bytes(raw.try_into().ok()?)),
        (b'i', 2) => json!(i16::from_le_bytes(raw.try_into().ok()?)),
        (b'i', 1) => json!(raw[0] as i8),
        (b'u', 8) => json!(u64::from_le_bytes(raw.try_into().ok()?)),
        (b'u', 4) => json!(u32::from_le_bytes(raw.try_into().ok()?)),
        (b'u', 2) => json!(u16::from_le_bytes(raw.try_into().ok()?)),
        (b'u', 1) => json!(raw[0]),
        (b'b', 1) => json!(raw[0] != 0),
        _ => return None,
    })
}

/// A numpy scalar (no shape) as its number, an array as nested lists (C order, as tolist() gives it); null for a
/// dtype that isn't a plain number (complex, a date, a string).
fn numpy(dtype: &str, raw: &Cbor, shape: &[usize]) -> Result<Json> {
    let Cbor::Bytes(raw) = raw else {
        bail!("cbor: numpy data that isn't bytes");
    };
    let size = dtype.get(2..).and_then(|size| size.parse::<usize>().ok()).filter(|size| *size > 0);
    // the lists to build, bounded (beside a zero-length axis, a huge one would cost nothing in bytes)
    let lists = shape.iter().try_fold(1usize, |total, axis| total.checked_mul((*axis).max(1)));
    let (Some(size), Some(_)) = (size, lists.filter(|lists| *lists <= 1 << 24)) else {
        return Ok(Json::Null);
    };
    if shape.iter().product::<usize>().checked_mul(size) != Some(raw.len()) {
        bail!("cbor: numpy {dtype} of shape {shape:?} in {} bytes", raw.len());
    }
    let Some(numbers) = raw.chunks(size).map(|chunk| numpy_number(dtype, chunk)).collect::<Option<Vec<_>>>() else {
        return Ok(Json::Null);
    };
    fn nest(numbers: &mut std::vec::IntoIter<Json>, shape: &[usize]) -> Json {
        match shape {
            [] => numbers.next().unwrap_or(Json::Null),
            [axis, rest @ ..] => Json::Array((0..*axis).map(|_| nest(numbers, rest)).collect()),
        }
    }
    Ok(nest(&mut numbers.into_iter(), shape))
}

/// LCM's Header stamp as dimos's lcm_decode makes its `ts`.
fn stamp(header: &msgs::Header) -> f64 {
    f64::from(header.stamp_sec) + f64::from(header.stamp_nsec) / 1e9
}

fn floats(reader: &mut Reader, count: usize) -> Result<Vec<f64>> {
    (0..count).map(|_| reader.f64()).collect()
}

fn vector3(position: [f64; 3]) -> Json {
    json!({ "__class__": "Vector3", "x": position[0], "y": position[1], "z": position[2] })
}

fn quaternion(orientation: [f64; 4]) -> Json {
    json!({ "__class__": "Quaternion", "x": orientation[0], "y": orientation[1], "z": orientation[2], "w": orientation[3] })
}

/// dimos's own message strings (the trajectory messages): an int32 length, then UTF-8 without a terminator.
fn plain_string(reader: &mut Reader) -> Result<String> {
    let length = reader.length()?;
    Ok(String::from_utf8(reader.take(length)?.to_vec())?)
}

/// A dimos message (tag 4047) as the object its lcm_decode builds, by its LCM fingerprint, with the fields the API
/// has always given for it. A message these RPCs don't carry is its class and size.
fn message(class: &str, lcm: &[u8]) -> Result<Json> {
    let (Some(fingerprint), Some(body)) = (lcm.get(..8), lcm.get(8..)) else {
        bail!("{class}: {} bytes of LCM", lcm.len());
    };
    let reader = &mut Reader::new(body);
    let class = short(class);
    let decoded = match <[u8; 8]>::try_from(fingerprint)? {
        msgs::JOINT_STATE_FINGERPRINT => joint_state_json(class, reader),
        msgs::POSE_STAMPED_FINGERPRINT => pose_stamped_json(class, reader),
        POSE_FINGERPRINT => msgs::read_pose(reader).map(|pose| json!({ "__class__": class, "position": vector3(pose.position), "orientation": quaternion(pose.orientation) })),
        JOINT_TRAJECTORY_FINGERPRINT => joint_trajectory_json(class, reader),
        TRAJECTORY_STATUS_FINGERPRINT => trajectory_status_json(class, reader),
        _ => return Ok(json!({ "__class__": class, "__bytes__": lcm.len() })),
    };
    decoded.map_err(|error| anyhow!("{class}'s LCM: {error}"))
}

/// sensor_msgs.JointState: the four array lengths, the header, then the arrays.
fn joint_state_json(class: &str, reader: &mut Reader) -> Result<Json> {
    let [names, positions, velocities, efforts] = [reader.length()?, reader.length()?, reader.length()?, reader.length()?];
    let header = msgs::read_header(reader)?;
    let name = (0..names).map(|_| reader.string()).collect::<Result<Vec<_>>>()?;
    let (position, velocity, effort) = (floats(reader, positions)?, floats(reader, velocities)?, floats(reader, efforts)?);
    Ok(json!({ "__class__": class, "ts": stamp(&header), "frame_id": header.frame_id, "name": name, "position": position, "velocity": velocity, "effort": effort }))
}

fn pose_stamped_json(class: &str, reader: &mut Reader) -> Result<Json> {
    let header = msgs::read_header(reader)?;
    let pose = msgs::read_pose(reader)?;
    Ok(json!({ "__class__": class, "frame_id": header.frame_id, "ts": stamp(&header), "position": vector3(pose.position), "orientation": quaternion(pose.orientation) }))
}

/// dimos's trajectory_msgs.JointTrajectory: timestamp, duration, the joint names, the points (each its time, joint
/// count, positions and velocities).
fn joint_trajectory_json(class: &str, reader: &mut Reader) -> Result<Json> {
    let timestamp = reader.f64()?;
    let duration = reader.f64()?;
    let names = reader.length()?;
    let joint_names = (0..names).map(|_| plain_string(reader)).collect::<Result<Vec<_>>>()?;
    let count = reader.length()?;
    let mut points = vec![];
    let mut first_joints = 0;
    for index in 0..count {
        let time_from_start = reader.f64()?;
        let joints = reader.length()?;
        let (positions, velocities) = (floats(reader, joints)?, floats(reader, joints)?);
        if index == 0 {
            first_joints = joints;
        }
        points.push(json!({ "__class__": "TrajectoryPoint", "time_from_start": time_from_start, "num_joints": joints, "positions": positions, "velocities": velocities }));
    }
    // as its lcm_decode counts them: the names, else the first point's
    let num_joints = if joint_names.is_empty() { first_joints } else { joint_names.len() };
    Ok(json!({ "__class__": class, "timestamp": timestamp, "duration": duration, "joint_names": joint_names, "num_joints": num_joints, "num_points": count, "points": points }))
}

/// dimos's trajectory_msgs.TrajectoryStatus.
fn trajectory_status_json(class: &str, reader: &mut Reader) -> Result<Json> {
    let timestamp = reader.f64()?;
    let state = reader.i32()?;
    let [progress, time_elapsed, time_remaining] = [reader.f64()?, reader.f64()?, reader.f64()?];
    let error = plain_string(reader)?;
    let state = json!({ "__class__": "TrajectoryState", "name": enum_name("TrajectoryState", &Cbor::Int(state.into())), "value": state });
    Ok(json!({ "__class__": class, "timestamp": timestamp, "state": state, "progress": progress, "time_elapsed": time_elapsed, "time_remaining": time_remaining, "error": error }))
}

/// A Python value for a request.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    None,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Out>),
    Tuple(Vec<Out>),
    Dict(Vec<(String, Out)>),
    /// a dimos message: its class (`"module:qualname"`) and its LCM bytes, as dimos's encoder sends one
    Message { class: String, lcm: Vec<u8> },
}

/// An item's initial byte and argument, in its shortest form (as cbor2 writes them).
fn head(out: &mut Vec<u8>, major: u8, argument: u64) {
    let major = major << 5;
    match argument {
        0..=23 => out.push(major | argument as u8),
        24..=0xff => out.extend([major | 24, argument as u8]),
        0x100..=0xffff => {
            out.push(major | 25);
            out.extend((argument as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(major | 26);
            out.extend((argument as u32).to_be_bytes());
        }
        _ => {
            out.push(major | 27);
            out.extend(argument.to_be_bytes());
        }
    }
}

fn write_text(out: &mut Vec<u8>, text: &str) {
    head(out, 3, text.len() as u64);
    out.extend(text.as_bytes());
}

fn write_array(out: &mut Vec<u8>, items: &[Out]) {
    head(out, 4, items.len() as u64);
    items.iter().for_each(|item| write(out, item));
}

fn write(out: &mut Vec<u8>, value: &Out) {
    match value {
        Out::None => out.push(0xf6),
        Out::Bool(flag) => out.push(if *flag { 0xf5 } else { 0xf4 }),
        Out::Int(number) if *number >= 0 => head(out, 0, *number as u64),
        Out::Int(number) => head(out, 1, (-1 - *number) as u64),
        // cbor2 writes a float as a double, but NaN and the infinities as halves
        Out::Float(number) if number.is_nan() => out.extend([0xf9, 0x7e, 0x00]),
        Out::Float(number) if number.is_infinite() => out.extend([0xf9, if *number > 0.0 { 0x7c } else { 0xfc }, 0x00]),
        Out::Float(number) => {
            out.push(0xfb);
            out.extend(number.to_be_bytes());
        }
        Out::Str(text) => write_text(out, text),
        Out::List(items) => write_array(out, items),
        Out::Tuple(items) => {
            head(out, 6, TAG_TUPLE);
            write_array(out, items);
        }
        Out::Dict(pairs) => {
            head(out, 5, pairs.len() as u64);
            for (key, value) in pairs {
                write_text(out, key);
                write(out, value);
            }
        }
        Out::Message { class, lcm } => {
            head(out, 6, TAG_DIMOSMSG);
            head(out, 4, 2);
            write_text(out, class);
            head(out, 2, lcm.len() as u64);
            out.extend(lcm);
        }
    }
}

/// CBOR for a value.
fn dumps(value: &Out) -> Vec<u8> {
    let mut out = vec![];
    write(&mut out, value);
    out
}

/// The payload of a dimos RPC call: `(args, kwargs)` as dimos's own client sends it (args a tuple).
pub fn rpc_request(args: Vec<Out>, kwargs: Vec<(&str, Out)>) -> Vec<u8> {
    dumps(&Out::Tuple(vec![
        Out::Tuple(args),
        Out::Dict(kwargs.into_iter().map(|(key, value)| (key.to_string(), value)).collect()),
    ]))
}

/// dimos's sec_nsec: `ts` split into whole seconds and nanoseconds, each truncated as Python's int() does.
fn sec_nsec(ts: f64) -> (i32, i32) {
    let sec = ts.trunc();
    (sec as i32, ((ts - sec) * 1e9).trunc() as i32)
}

fn push_lcm_string(out: &mut Vec<u8>, text: &str) {
    out.extend((text.len() as u32 + 1).to_be_bytes());
    out.extend(text.as_bytes());
    out.push(0);
}

/// std_msgs.Header: seq (0, as dimos leaves it), stamp, frame_id.
fn push_header(out: &mut Vec<u8>, ts: f64, frame_id: &str) {
    let (sec, nsec) = sec_nsec(ts);
    out.extend(0i32.to_be_bytes());
    out.extend(sec.to_be_bytes());
    out.extend(nsec.to_be_bytes());
    push_lcm_string(out, frame_id);
}

/// `dimos.msgs.sensor_msgs.JointState` (no velocity or effort), as its lcm_encode writes it.
pub fn joint_state(names: &[String], positions: &[f64], ts: f64) -> Out {
    let mut lcm = msgs::JOINT_STATE_FINGERPRINT.to_vec();
    for length in [names.len(), positions.len(), 0, 0] {
        lcm.extend((length as i32).to_be_bytes());
    }
    push_header(&mut lcm, ts, "");
    names.iter().for_each(|name| push_lcm_string(&mut lcm, name));
    positions.iter().for_each(|position| lcm.extend(position.to_be_bytes()));
    Out::Message { class: JOINT_STATE.into(), lcm }
}

/// `dimos.msgs.geometry_msgs.PoseStamped` at position [x, y, z], orientation [x, y, z, w] in frame, as its lcm_encode
/// writes it.
pub fn pose_stamped(frame: &str, position: [f64; 3], orientation: [f64; 4], ts: f64) -> Out {
    let mut lcm = msgs::POSE_STAMPED_FINGERPRINT.to_vec();
    push_header(&mut lcm, ts, frame);
    position.iter().chain(&orientation).for_each(|value| lcm.extend(value.to_be_bytes()));
    Out::Message { class: POSE_STAMPED.into(), lcm }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/src/cbor_fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    fn reply(name: &str) -> Json {
        decode(&fixture(&format!("{name}.cbor"))).unwrap()
    }

    const REPLIES: [&str; 13] = [
        "get_state",
        "get_state_dual",
        "list_planning_groups",
        "list_planning_groups_dual",
        "plan_to_joints",
        "plan_to_poses",
        "execute",
        "execute_accepted",
        "cancel",
        "clear_planned_path",
        "get_obstacles",
        "get_obstacles_scene",
        "error",
    ];

    /// What the API gives for each reply dimos's encoder wrote (scripts/make_cbor_fixtures.py), kept as
    /// `<name>.json`: the JSON the pickled replies gave before dimos#4821, value for value (checked when this came in
    /// against the pickle decoder it replaced, on the same values and on the sim's pickled replies). UPDATE_CBOR_FIXTURES=1
    /// rewrites them.
    #[test]
    fn replies_give_the_api_its_json() {
        for name in REPLIES {
            let text = serde_json::to_string(&reply(name)).unwrap() + "\n";
            let path = format!("{}/src/cbor_fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
            if std::env::var("UPDATE_CBOR_FIXTURES").is_ok() {
                std::fs::write(&path, &text).unwrap();
            }
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "{name}: run with UPDATE_CBOR_FIXTURES=1 if the change is meant");
        }
    }

    #[test]
    fn decodes_get_state() {
        let state = reply("get_state");
        assert_eq!(state["__class__"], "ManipulationSnapshot");
        // the capture's operation_status (4) under today's OperationStatus
        assert_eq!(state["operation_status"], json!({ "__class__": "OperationStatus", "name": "EXECUTING", "value": 4 }));
        assert_eq!(state["execution_status"]["name"], "COMPLETED");
        assert_eq!(state["error"], Json::Null);
        assert_eq!(state["has_pending_plan"], false);
        let group = &state["groups"]["manipulator"];
        assert_eq!(group["joints"]["__class__"], "JointState");
        assert_eq!(group["joints"]["name"][6], "joint7");
        assert!((group["joints"]["position"][0].as_f64().unwrap() + 1.0).abs() < 1e-6);
        assert_eq!(group["end_effector_pose"]["frame_id"], "world");
        assert!((group["end_effector_pose"]["position"]["x"].as_f64().unwrap() - 0.32592797).abs() < 1e-6);
        assert!((group["end_effector_pose"]["orientation"]["w"].as_f64().unwrap() - 0.223821).abs() < 1e-5);
        assert_eq!(group["end_effector_pose"]["orientation"]["__class__"], "Quaternion");
        assert_eq!(group["joint_presets"]["home"]["position"][3], 0.909);
        assert!(group["joint_presets"]["init"]["position"].is_array());

        let dual = reply("get_state_dual");
        assert_eq!(dual["operation_status"]["name"], "HAS_PLAN");
        assert_eq!(dual["has_pending_plan"], true);
        let left = &dual["groups"]["left_manipulator"];
        assert_eq!(left["joints"]["name"][0], "left_joint1");
        assert_eq!(left["joints"]["velocity"], json!([]));
        assert_eq!(left["gripper_position"], 0.8513);
        assert_eq!(left["joint_presets"]["home"]["position"][1], 1.0473);
        // a stamp comes back as dimos's lcm_decode makes it from sec and nsec
        assert!((left["joints"]["ts"].as_f64().unwrap() - 1794546541.2834).abs() < 1e-6);
        let right = &dual["groups"]["right_manipulator"];
        assert_eq!(right["end_effector_pose"], Json::Null);
        assert_eq!(right["gripper_position"], Json::Null);
        assert_eq!(right["joint_presets"], json!({}));
    }

    #[test]
    fn decodes_a_plan_with_its_trajectory() {
        let result = reply("plan_to_joints");
        assert_eq!(result["status"]["name"], "SUCCEEDED");
        let plan = &result["plan"];
        assert_eq!(plan["plan_id"], "84a9de8e36c04ece99efcd5d7716bf88");
        assert_eq!(plan["status"]["name"], "SUCCESS");
        assert_eq!(plan["group_ids"], json!(["manipulator"]));
        assert_eq!(plan["path"][1]["__class__"], "JointState");
        let trajectory = &plan["trajectory"];
        assert_eq!(trajectory["__class__"], "JointTrajectory");
        assert_eq!(trajectory["joint_names"].as_array().unwrap().len(), 7);
        assert_eq!(trajectory["num_joints"], 7);
        let points = trajectory["points"].as_array().unwrap();
        assert_eq!(points.len(), 254);
        assert_eq!(trajectory["num_points"], 254);
        let last = points.last().unwrap();
        let end: Vec<f64> = last["positions"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(end.len(), 7);
        assert!((end[0] - 0.6).abs() < 1e-3 && (end[3] - 1.2).abs() < 1e-3, "{end:?}");
        assert!((last["time_from_start"].as_f64().unwrap() - 2.5298).abs() < 1e-3);
        assert_eq!(trajectory["duration"], last["time_from_start"]);
    }

    #[test]
    fn decodes_the_small_replies() {
        let groups = reply("list_planning_groups");
        assert_eq!(groups[0]["__class__"], "PlanningGroupInfo");
        assert_eq!(groups[0]["tip_frame"], "link_tcp");
        assert_eq!(groups[0]["joint_names"][0], "joint1");
        assert_eq!(groups[0]["has_gripper"], true);
        let dual = reply("list_planning_groups_dual");
        assert_eq!(dual[1]["id"], "right_manipulator");
        assert_eq!(dual[1]["tip_frame"], Json::Null);
        assert_eq!(reply("get_obstacles"), json!({}));
        let scene = reply("get_obstacles_scene");
        assert_eq!(scene["mug"]["__class__"], "PoseStamped");
        assert_eq!(scene["mug"]["orientation"]["z"], 0.3826834);
        assert_eq!(scene["table"]["ts"], 1794546541.5);
        let cleared = reply("clear_planned_path");
        assert_eq!(cleared["status"]["name"], "SUCCEEDED");
        assert_eq!(reply("execute")["status"]["name"], "NO_PLAN");
        let accepted = reply("execute_accepted");
        assert_eq!(accepted["status"]["name"], "ACCEPTED");
        assert_eq!(accepted["coordinator_result"]["status"]["name"], "ACCEPTED");
        let cancelled = reply("cancel");
        assert_eq!(cancelled["trajectory_status"]["state"], json!({ "__class__": "TrajectoryState", "name": "COMPLETED", "value": 2 }));
        assert_eq!(cancelled["trajectory_status"]["progress"], 1.0);
        assert_eq!(reply("plan_to_poses")["status"]["name"], "FAILED");
        // what dimos replies to a pickled request: its serialized IndexError
        let error = reply("error");
        assert_eq!(error["type_name"], "IndexError");
        assert_eq!(error["args"], json!(["list index out of range"]));
    }

    /// The enum table names every member dimos has (scripts/make_cbor_fixtures.py writes enums.json from its classes).
    #[test]
    fn enum_names_match_dimos() {
        let enums: Json = serde_json::from_slice(&fixture("enums.json")).unwrap();
        for (class, members) in enums.as_object().unwrap() {
            for (name, value) in members.as_object().unwrap() {
                let value = Cbor::Int(value.as_i64().unwrap().into());
                assert_eq!(enum_name(class, &value), Some(name.as_str()), "{class}.{name}");
            }
            let past = members.as_object().unwrap().values().map(|value| value.as_i64().unwrap()).max().unwrap() + 1;
            assert_eq!(enum_name(class, &Cbor::Int(past.into())), None, "{class} has more members here than in dimos");
        }
    }

    /// The encoder's bytes for each request shape, checked in as `ours_<name>.req.cbor` so a Python with dimos can run
    /// them through dimos's RPC server (scripts/check_cbor_requests.py). UPDATE_CBOR_FIXTURES=1 rewrites them.
    #[test]
    fn encoder_fixtures_are_current() {
        let names: Vec<String> = (1..=7).map(|i| format!("joint{i}")).collect();
        let requests = [
            ("empty", rpc_request(vec![], vec![])),
            ("execute", rpc_request(vec![], vec![("blocking", Out::Bool(false)), ("plan_id", Out::Str("84a9de8e36c04ece99efcd5d7716bf88".into()))])),
            ("plan_to_joints", rpc_request(vec![Out::Dict(vec![("manipulator".into(), joint_state(&names, &[0.6, 0.1, 0.0, 1.2, 0.0, 1.0, 0.0], 1791963651.7957))])], vec![("speed_scale", Out::Float(0.5))])),
            ("plan_to_poses", rpc_request(vec![Out::Dict(vec![("manipulator".into(), pose_stamped("world", [0.35, 0.2, 0.45], [1.0, 0.0, 0.0, 0.0], 1791963651.7957))])], vec![])),
            (
                "plan_to_poses_dual",
                rpc_request(
                    vec![Out::Dict(vec![
                        // the tool pointing down
                        ("left_manipulator".into(), pose_stamped("world", [0.4012, 0.2337, 0.3121], [0.0, 1.0, 0.0, 0.0], 1794546541.2834)),
                        ("right_manipulator".into(), pose_stamped("world", [0.4012, -0.2337, 0.3121], [0.0, 1.0, 0.0, 0.0], 1794546541.2834)),
                    ])],
                    vec![("speed_scale", Out::Float(0.25))],
                ),
            ),
        ];
        for (name, bytes) in requests {
            let path = format!("{}/src/cbor_fixtures/ours_{name}.req.cbor", env!("CARGO_MANIFEST_DIR"));
            if std::env::var("UPDATE_CBOR_FIXTURES").is_ok() {
                std::fs::write(&path, &bytes).unwrap();
            }
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "{name}: run with UPDATE_CBOR_FIXTURES=1 and re-check with scripts/check_cbor_requests.py");
        }
    }

    /// Requests read back through the decoder: the tuple and message tags, the kwargs, a JointState's fields.
    #[test]
    fn requests_round_trip() {
        let names: Vec<String> = (1..=2).map(|i| format!("joint{i}")).collect();
        let bytes = rpc_request(vec![Out::Dict(vec![("arm".into(), joint_state(&names, &[0.25, -1.5], 1700000000.25))])], vec![("speed_scale", Out::Float(0.5)), ("n", Out::Int(-3)), ("big", Out::Int(1 << 40)), ("none", Out::None)]);
        let request = decode(&bytes).unwrap();
        assert_eq!(request[1], json!({ "speed_scale": 0.5, "n": -3, "big": 1u64 << 40, "none": null }));
        assert_eq!(request[0][0]["arm"], json!({ "__class__": "JointState", "ts": 1700000000.25, "frame_id": "", "name": ["joint1", "joint2"], "position": [0.25, -1.5], "velocity": [], "effort": [] }));
        let pose = decode(&dumps(&pose_stamped("map", [1.0, 2.0, 3.0], [0.0, 0.0, 0.0, 1.0], 12.5))).unwrap();
        assert_eq!(pose["frame_id"], "map");
        assert_eq!(pose["ts"], 12.5);
        assert_eq!(pose["position"], json!({ "__class__": "Vector3", "x": 1.0, "y": 2.0, "z": 3.0 }));
        // the shortest heads, as cbor2 writes them
        assert_eq!(dumps(&Out::Int(23)), [0x17]);
        assert_eq!(dumps(&Out::Int(24)), [0x18, 24]);
        assert_eq!(dumps(&Out::Int(-1)), [0x20]);
        assert_eq!(dumps(&Out::Int(-500)), [0x39, 0x01, 0xf3]);
        assert_eq!(dumps(&Out::Float(f64::NAN)), [0xf9, 0x7e, 0x00]);
        assert_eq!(dumps(&Out::Tuple(vec![])), [0xd9, 0x0f, 0xc8, 0x80]);
    }

    #[test]
    fn reads_what_cbor2_can_write() {
        // half and single floats, a negative bignum, undefined, sets, a dict with tuple keys
        assert_eq!(decode(&[0xf9, 0x3c, 0x00]).unwrap(), json!(1.0));
        assert_eq!(decode(&[0xf9, 0x7c, 0x00]).unwrap(), Json::Null);
        assert_eq!(decode(&[0xfa, 0x3f, 0xc0, 0x00, 0x00]).unwrap(), json!(1.5));
        assert_eq!(decode(&[0xc3, 0x49, 1, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap(), json!(-18446744073709551617.0));
        assert_eq!(decode(&[0xf7]).unwrap(), Json::Null);
        assert_eq!(decode(&[0xd9, 0x0f, 0xca, 0x82, 0x01, 0x02]).unwrap(), json!([1, 2]));
        let tuple_key = [0xd9, 0x0f, 0xd8, 0x81, 0x82, 0xd9, 0x0f, 0xc8, 0x82, 0x61, b'a', 0x01, 0xf5];
        assert_eq!(decode(&tuple_key).unwrap(), json!({ "[\"a\",1]": true }));
        // a numpy float64 scalar and a 2x2 int32 array
        let mut scalar = vec![0xd9, 0x0f, 0xcd, 0x82, 0x63, b'<', b'f', b'8', 0x48];
        scalar.extend(2.5f64.to_le_bytes());
        assert_eq!(decode(&scalar).unwrap(), json!(2.5));
        let mut array = vec![0xd9, 0x0f, 0xcc, 0x83, 0x63, b'<', b'i', b'4', 0x82, 0x02, 0x02, 0x50];
        [1i32, 2, 3, 4].iter().for_each(|value| array.extend(value.to_le_bytes()));
        assert_eq!(decode(&array).unwrap(), json!([[1, 2], [3, 4]]));
        // a class by reference, a message type this doesn't read
        assert_eq!(decode(&[0xd9, 0x0f, 0xd3, 0x63, b'a', b':', b'B']).unwrap(), json!({ "__class__": "a.B" }));
        let unknown = [0xd9, 0x0f, 0xcf, 0x82, 0x63, b'm', b':', b'M', 0x48, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(decode(&unknown).unwrap(), json!({ "__class__": "M", "__bytes__": 8 }));
    }

    #[test]
    fn rejects_truncated_and_malformed() {
        let mut bytes = fixture("get_state.cbor");
        bytes.truncate(bytes.len() / 2);
        assert!(decode(&bytes).is_err());
        // a pickle (what the RPCs carried before): 0x80 is an empty array, and the rest is left over
        assert!(decode(&[0x80, 0x04, 0x95]).is_err());
        assert!(decode(&[0x9f, 0xff]).is_err());
        assert!(decode(&[0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).is_err());
        // a JointState whose LCM is cut short
        let Out::Message { class, mut lcm } = joint_state(&["a".into()], &[1.0], 1.0) else { panic!() };
        lcm.truncate(lcm.len() - 4);
        assert!(decode(&dumps(&Out::Message { class, lcm })).is_err());
        let deep: Vec<u8> = std::iter::repeat_n(0x81, 500).chain([0x00]).collect();
        assert!(decode(&deep).is_err());
    }
}
