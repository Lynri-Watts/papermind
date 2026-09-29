/**
 * React Flow 自定义思维导图边。
 *
 * 两条渲染路径：
 * - 初始/重新布局刚由 mermaid 同源布局产出时，data.geom.d 是 mermaid 官方 SVG 里
 *   边的原始 path（已平移进 RF 坐标系），连同官方 stroke/线宽原样绘制——
 *   与代码面板预览逐像素同源；
 * - 用户拖拽、增补节点后实测几何失效（画布清除 edgeGeom），回退到 React Flow
 *   的水平贝塞尔曲线（source 在父节点右中点、target 在子节点左中点），
 *   颜色取该边所属根分支的 section 色、线宽随树层级（11/5/3，实测自 mermaid）。
 *
 * 边永远无箭头（mindmap classic 无 marker）。
 */
import React from 'react';
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { MermaidEdgeGeom } from '../../lib/mindmap';

export type MindmapEdgeData = {
  /** mermaid 实测 path 几何；缺失即走贝塞尔降级 */
  geom?: MermaidEdgeGeom;
  /** 降级贝塞尔的 section 配色与层级线宽 */
  fallbackStroke: string;
  fallbackWidth: number;
} & Record<string, unknown>;

export type MindmapFlowEdge = Edge<MindmapEdgeData, 'mindmap'>;

const MindmapEdgeView: React.FC<EdgeProps<MindmapFlowEdge>> = (props) => {
  const {
    id, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition, data,
  } = props;

  const geom = data?.geom;
  const stroke = geom?.stroke ?? data?.fallbackStroke ?? '#475569';
  const strokeWidth = geom?.strokeWidth ?? data?.fallbackWidth ?? 1.5;
  const d = geom?.d ?? getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })[0];

  return (
    <BaseEdge
      id={id}
      path={d}
      interactionWidth={strokeWidth + 12}
      style={{ stroke, strokeWidth, fill: 'none' }}
    />
  );
};

export default MindmapEdgeView;
