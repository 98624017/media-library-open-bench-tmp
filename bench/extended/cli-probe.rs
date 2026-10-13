// Generic loopback fixture client; does not implement or publish the product CLI.
use std::{env, fs, io::{Read, Write}, net::{SocketAddr, TcpStream}, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args().nth(1).ok_or("Missing fixture discovery")?;
    let raw = fs::read_to_string(path)?;
    // This private test fixture has one canonical numeric port field.
    let value = raw.split("\"port\":").nth(1).ok_or("Missing port")?;
    let digits: String = value.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    let port: u16 = digits.parse()?;
    if port == 0 { return Err("Invalid port".into()); }
    let address: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    stream.write_all(b"GET /state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut bytes = Vec::new();
    (&mut stream).take(16_385).read_to_end(&mut bytes)?;
    if bytes.len() > 16_384 { return Err("Oversized response".into()); }
    let response = String::from_utf8(bytes)?;
    if !response.starts_with("HTTP/1.1 200") { return Err("Fixture response status".into()); }
    let body = response.split_once("\r\n\r\n").ok_or("Missing body")?.1;
    print!("{body}");
    Ok(())
}
