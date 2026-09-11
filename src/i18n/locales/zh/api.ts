/** API 层（src/api/index.ts）错误与提示文案 */
export default {
  stream: {
    /** SSE stage 帧缺失 label 时的兜底提示 */
    processing: '处理中...',
    /** 浏览器不支持 ReadableStream 时的错误 */
    unsupported: '浏览器不支持流式响应',
  },
  rag: {
    /** SSE error 帧缺失 message 时的兜底提示 */
    failed: 'RAG 问答失败',
  },
  note: {
    /** 本地保留语义：后端未提供笔记编辑接口 */
    editUnsupported: '后端暂不支持编辑笔记，请删除后重建',
  },
} as const;
