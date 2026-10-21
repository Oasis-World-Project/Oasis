// 增量解析 text/event-stream：每收到一个完整事件就回调它的 data（多行 data 用换行拼接）。
// 注释行（以冒号开头，上游常用来保活）忽略。
export interface SseParser {
  push(chunk: string): void;
  /** 流结束时调用，处理末尾没有空行收尾的事件。 */
  end(): void;
}

export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = '';
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) onData(dataLines.join('\n'));
    dataLines = [];
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') dispatch();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        newline = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
      buffer = '';
      dispatch();
    },
  };
}
