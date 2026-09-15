#[derive(Default)]
pub struct SseDecoder {
    pending_line: Vec<u8>,
    pending_data: Vec<String>,
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut events = Vec::new();
        for &byte in chunk {
            self.pending_line.push(byte);
            if byte == b'\n' {
                let mut line = std::mem::take(&mut self.pending_line);
                line.pop();
                if matches!(line.last(), Some(b'\r')) {
                    line.pop();
                }
                if let Some(event) = self.process_line(&line)? {
                    events.push(event);
                }
            }
        }
        Ok(events)
    }

    pub fn has_pending(&self) -> bool {
        !self.pending_line.is_empty() || !self.pending_data.is_empty()
    }

    pub fn finish(&mut self) -> Result<Vec<String>, String> {
        let mut events = Vec::new();
        if !self.pending_line.is_empty() {
            let mut line = std::mem::take(&mut self.pending_line);
            if matches!(line.last(), Some(b'\r')) {
                line.pop();
            }
            if let Some(event) = self.process_line(&line)? {
                events.push(event);
            }
        }
        if let Some(event) = self.finish_event() {
            events.push(event);
        }
        Ok(events)
    }

    fn process_line(&mut self, line: &[u8]) -> Result<Option<String>, String> {
        let line =
            std::str::from_utf8(line).map_err(|_| "Invalid UTF-8 in SSE stream".to_string())?;

        if line.is_empty() {
            return Ok(self.finish_event());
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        if line == "data" {
            self.pending_data.push(String::new());
            return Ok(None);
        }
        if let Some(data) = line.strip_prefix("data:") {
            self.pending_data
                .push(data.strip_prefix(' ').unwrap_or(data).to_string());
        }

        Ok(None)
    }

    fn finish_event(&mut self) -> Option<String> {
        if self.pending_data.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.pending_data).join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::SseDecoder;

    fn collect_with_every_split(input: &[u8]) -> Vec<Vec<String>> {
        (0..=input.len())
            .map(|split| {
                let mut decoder = SseDecoder::default();
                let mut events = decoder.push(&input[..split]).unwrap();
                events.extend(decoder.push(&input[split..]).unwrap());
                events
            })
            .collect()
    }

    #[test]
    fn agent_maestro_sse_decoder_handles_every_utf8_byte_split_for_chinese_content() {
        let input = b"data: {\"text\":\"\xE4\xB8\xAD\xE6\x96\x87\"}\r\n\r\n";

        for events in collect_with_every_split(input) {
            assert_eq!(events, vec![r#"{"text":"中文"}"#.to_string()]);
        }
    }

    #[test]
    fn agent_maestro_sse_decoder_ignores_heartbeats_and_event_labels() {
        let input =
            b": keep-alive\r\nevent: error\r\ndata: {\"error\":{\"message\":\"boom\"}}\r\n\r\n";

        for events in collect_with_every_split(input) {
            assert_eq!(events, vec![r#"{"error":{"message":"boom"}}"#.to_string()]);
        }
    }

    #[test]
    fn agent_maestro_sse_decoder_handles_multiple_frames_per_chunk() {
        let input = b"data: {\"n\":1}\n\ndata: {\"n\":2}\n\n";

        for events in collect_with_every_split(input) {
            assert_eq!(
                events,
                vec![r#"{"n":1}"#.to_string(), r#"{"n":2}"#.to_string()]
            );
        }
    }

    #[test]
    fn agent_maestro_sse_decoder_combines_multiline_data() {
        let input = b"data: first\r\ndata: second\r\n\r\n";

        for events in collect_with_every_split(input) {
            assert_eq!(events, vec!["first\nsecond".to_string()]);
        }
    }

    #[test]
    fn agent_maestro_sse_decoder_accepts_data_lines_without_a_space() {
        let input = b"data:{\"ok\":true}\n\n";

        for events in collect_with_every_split(input) {
            assert_eq!(events, vec![r#"{"ok":true}"#.to_string()]);
        }
    }

    #[test]
    fn agent_maestro_sse_decoder_reports_invalid_utf8_explicitly() {
        let input = b"data: \xE4\xB8\n\n";

        for split in 0..=input.len() {
            let mut decoder = SseDecoder::default();
            let error = match decoder.push(&input[..split]) {
                Err(error) => error,
                Ok(_) => decoder.push(&input[split..]).unwrap_err(),
            };
            assert!(!error.is_empty());
            assert!(error.to_ascii_lowercase().contains("utf-8"));
        }
    }

    #[test]
    fn agent_maestro_sse_decoder_flushes_pending_eof_event_without_final_blank_line() {
        let input = b"data: {\"tail\":\"value\"}";

        for split in 0..=input.len() {
            let mut decoder = SseDecoder::default();
            let mut events = decoder.push(&input[..split]).unwrap();
            events.extend(decoder.push(&input[split..]).unwrap());
            assert!(events.is_empty());
            assert!(decoder.has_pending());
            let tail = decoder.finish().unwrap();
            assert_eq!(tail, vec![r#"{"tail":"value"}"#.to_string()]);
            assert!(!decoder.has_pending());
        }
    }
}
