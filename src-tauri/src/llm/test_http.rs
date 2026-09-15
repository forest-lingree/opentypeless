use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) struct HttpFixture {
    pub(crate) base_url: String,
    pub(crate) requests: Receiver<CapturedRequest>,
}

pub(crate) struct HttpResponseFixture<'a> {
    pub(crate) status_line: &'a str,
    pub(crate) content_type: &'a str,
    pub(crate) body: &'a str,
}

impl<'a> HttpResponseFixture<'a> {
    pub(crate) fn json(body: &'a str) -> Self {
        Self {
            status_line: "200 OK",
            content_type: "application/json",
            body,
        }
    }
}

#[derive(Debug)]
pub(crate) struct CapturedRequest {
    text: String,
    body_start: usize,
}

impl CapturedRequest {
    pub(crate) fn as_text(&self) -> &str {
        &self.text
    }

    pub(crate) fn path(&self) -> &str {
        self.text
            .lines()
            .next()
            .expect("fixture request must include a request line")
            .split_whitespace()
            .nth(1)
            .expect("fixture request line must include a path")
    }

    pub(crate) fn body(&self) -> &str {
        &self.text[self.body_start..]
    }
}

pub(crate) fn spawn_http_fixture(response: HttpResponseFixture<'static>) -> HttpFixture {
    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture listener must bind");
    listener
        .set_nonblocking(true)
        .expect("fixture listener must become nonblocking");
    let addr = listener
        .local_addr()
        .expect("fixture listener must have an address");
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let accept_deadline = Instant::now() + ACCEPT_TIMEOUT;
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < accept_deadline,
                        "timed out waiting for fixture request after {:?}",
                        ACCEPT_TIMEOUT
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            }
        };

        stream
            .set_nonblocking(false)
            .expect("fixture stream must become blocking");
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .expect("fixture stream must set read timeout");
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .expect("fixture stream must set write timeout");

        let request = read_request(&mut stream);
        tx.send(request)
            .expect("fixture must deliver the captured request");

        let response_text = format!(
            "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response.status_line,
            response.content_type,
            response.body.len(),
            response.body
        );
        stream
            .write_all(response_text.as_bytes())
            .expect("fixture response write must succeed");
        stream.flush().expect("fixture response flush must succeed");
    });

    HttpFixture {
        base_url: format!("http://{}", addr),
        requests: rx,
    }
}

fn read_request(stream: &mut TcpStream) -> CapturedRequest {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];

    let header_end = loop {
        let read = stream
            .read(&mut buffer)
            .expect("fixture request read must succeed");
        assert!(
            read > 0,
            "fixture client closed before sending request headers"
        );
        request.extend_from_slice(&buffer[..read]);

        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break header_end;
        }
    };

    let headers = std::str::from_utf8(&request[..header_end + 4])
        .expect("fixture request headers must be valid UTF-8");
    let content_length = parse_content_length(headers);
    let expected_len = header_end + 4 + content_length;

    while request.len() < expected_len {
        let read = stream
            .read(&mut buffer)
            .expect("fixture request body read must succeed");
        assert!(
            read > 0,
            "fixture client closed before sending full request body"
        );
        request.extend_from_slice(&buffer[..read]);
    }

    CapturedRequest {
        text: String::from_utf8(request).expect("fixture request must be valid UTF-8"),
        body_start: header_end + 4,
    }
}

fn parse_content_length(headers: &str) -> usize {
    headers
        .split("\r\n")
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                Some(
                    value
                        .trim()
                        .parse()
                        .expect("fixture Content-Length must be numeric"),
                )
            } else {
                None
            }
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_maestro_fixture_captures_full_request_body_before_responding() {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(r#"{"ok":true}"#));
        let address = fixture
            .base_url
            .strip_prefix("http://")
            .expect("fixture base URL must use http");

        let mut stream = TcpStream::connect(address).expect("fixture client must connect");
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .expect("fixture client must set read timeout");
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .expect("fixture client must set write timeout");

        stream
            .write_all(
                b"POST /capture HTTP/1.1\r\nHost: localhost\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello",
            )
            .expect("fixture client must write request head");
        thread::sleep(Duration::from_millis(50));
        stream
            .write_all(b" world")
            .expect("fixture client must write request tail");
        stream.flush().expect("fixture client must flush request");

        let request = fixture
            .requests
            .recv_timeout(REQUEST_TIMEOUT)
            .expect("fixture must capture the request");
        assert_eq!(request.path(), "/capture");
        assert_eq!(request.body(), "hello world");

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("fixture client must read the response");
        assert!(response.starts_with("HTTP/1.1 200 OK"));
    }
}
