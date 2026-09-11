import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Network, Info, ZoomIn, ZoomOut, Maximize2, RotateCcw } from 'lucide-react';
import { getGraphData } from '../api';
import { GraphNode, GraphEdge } from '../types';

const GraphPage: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const nodePositions = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const [zoomDisplay, setZoomDisplay] = useState(100);

  useEffect(() => {
    loadGraphData();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const displayWidth = Math.floor(rect.width);
        const displayHeight = Math.floor(rect.height);
        
        canvasRef.current.width = displayWidth;
        canvasRef.current.height = displayHeight;
        canvasRef.current.style.width = displayWidth + 'px';
        canvasRef.current.style.height = displayHeight + 'px';
        
        if (nodes.length > 0) {
          initializePositions();
        }
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [nodes.length]);

  useEffect(() => {
    if (nodes.length > 0 && canvasRef.current) {
      initializePositions();
      startAnimation();
    }
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [nodes]);

  const loadGraphData = async () => {
    setLoading(true);
    try {
      const response = await getGraphData();
      setNodes(response.nodes);
      setEdges(response.edges);
    } catch (error) {
      console.error('Error loading graph data:', error);
    } finally {
      setLoading(false);
    }
  };

  const initializePositions = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = canvas.width;
    const height = canvas.height;
    const radius = Math.min(width, height) * 0.35;

    const newPositions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    
    nodes.forEach((node, index) => {
      const angle = (index / nodes.length) * Math.PI * 2;
      const nodeRadius = radius * (0.7 + Math.random() * 0.3);
      newPositions.set(node.id, {
        x: Math.cos(angle) * nodeRadius,
        y: Math.sin(angle) * nodeRadius,
        vx: 0,
        vy: 0
      });
    });

    nodePositions.current = newPositions;
  };

  const startAnimation = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const animate = () => {
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;

      const zoom = zoomRef.current;
      const pan = panRef.current;

      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(centerX + pan.x, centerY + pan.y);
      ctx.scale(zoom, zoom);

      const repulsion = 3000;
      const attraction = 0.001;
      const damping = 0.9;
      const centerGravity = 0.003;

      nodePositions.current.forEach((pos) => {
        pos.vx += -pos.x * centerGravity;
        pos.vy += -pos.y * centerGravity;
      });

      const positions = Array.from(nodePositions.current.entries());
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const [, pos1] = positions[i];
          const [, pos2] = positions[j];
          
          const dx = pos1.x - pos2.x;
          const dy = pos1.y - pos2.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (distance * distance);
          
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          
          pos1.vx += fx;
          pos1.vy += fy;
          pos2.vx -= fx;
          pos2.vy -= fy;
        }
      }

      edges.forEach((edge) => {
        const sourcePos = nodePositions.current.get(edge.source);
        const targetPos = nodePositions.current.get(edge.target);
        
        if (sourcePos && targetPos) {
          const dx = targetPos.x - sourcePos.x;
          const dy = targetPos.y - sourcePos.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          
          const fx = (dx / distance) * attraction * distance;
          const fy = (dy / distance) * attraction * distance;
          
          sourcePos.vx += fx;
          sourcePos.vy += fy;
          targetPos.vx -= fx;
          targetPos.vy -= fy;
        }
      });

      nodePositions.current.forEach((pos) => {
        pos.vx *= damping;
        pos.vy *= damping;
        pos.x += pos.vx;
        pos.y += pos.vy;
      });

      edges.forEach((edge) => {
        const sourcePos = nodePositions.current.get(edge.source);
        const targetPos = nodePositions.current.get(edge.target);
        
        if (sourcePos && targetPos) {
          ctx.beginPath();
          ctx.moveTo(sourcePos.x, sourcePos.y);
          ctx.lineTo(targetPos.x, targetPos.y);
          
          let edgeColor = '#475569';
          if (edge.type === 'cites') edgeColor = '#EF4444';
          if (edge.type === 'author') edgeColor = '#A855F7';
          if (edge.type === 'related') edgeColor = '#3B82F6';
          
          ctx.strokeStyle = edgeColor;
          ctx.lineWidth = edge.type === 'cites' ? 1.5 : 1;
          ctx.stroke();
        }
      });

      nodes.forEach((node) => {
        const pos = nodePositions.current.get(node.id);
        if (!pos) return;

        const isHovered = hoveredNode?.id === node.id;
        const isSelected = selectedNode?.id === node.id;
        const baseSize = node.type === 'paper' ? 8 : node.type === 'topic' ? 6 : 5;
        const size = baseSize * (isSelected ? 1.3 : isHovered ? 1.15 : 1);

        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, size + 4, 0, Math.PI * 2);
          ctx.fillStyle = isSelected ? 'rgba(59, 130, 246, 0.3)' : 'rgba(139, 92, 246, 0.2)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
        ctx.fillStyle = node.color || '#3B82F6';
        ctx.fill();
        
        if (isSelected || isHovered) {
          ctx.strokeStyle = '#F8FAFC';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        ctx.save();
        ctx.scale(1/zoom, 1/zoom);
        ctx.fillStyle = '#E2E8F0';
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const label = node.label.length > 18 ? node.label.substring(0, 18) + '..' : node.label;
        ctx.fillText(label, pos.x * zoom, (pos.y + size + 16) * zoom);
        ctx.restore();
      });

      ctx.restore();

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();
  };

  const getMousePos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const zoom = zoomRef.current;
    const pan = panRef.current;
    
    const x = (e.clientX - rect.left - centerX - pan.x) / zoom;
    const y = (e.clientY - rect.top - centerY - pan.y) / zoom;
    
    return { x, y };
  }, []);

  const getNodeAtPosition = useCallback((x: number, y: number): GraphNode | null => {
    let closestNode: GraphNode | null = null;
    let minDistance = Infinity;

    nodes.forEach((node) => {
      const pos = nodePositions.current.get(node.id);
      if (pos) {
        const distance = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
        const baseSize = node.type === 'paper' ? 8 : node.type === 'topic' ? 6 : 5;
        const hitRadius = baseSize + 6;
        if (distance < hitRadius && distance < minDistance) {
          minDistance = distance;
          closestNode = node;
        }
      }
    });

    return closestNode;
  }, [nodes]);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, moved: false, button: -1 });

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    dragStartRef.current = { 
      x: e.clientX - rect.left, 
      y: e.clientY - rect.top, 
      moved: false,
      button: e.button 
    };
    isDraggingRef.current = false;
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragStartRef.current.button === 0) {
      const dx = x - dragStartRef.current.x;
      const dy = y - dragStartRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > 3) {
        isDraggingRef.current = true;
        dragStartRef.current.moved = true;
        dragStartRef.current.x = x;
        dragStartRef.current.y = y;
        
        panRef.current = {
          x: panRef.current.x + dx,
          y: panRef.current.y + dy
        };
        return;
      }
    }

    if (!isDraggingRef.current) {
      const pos = getMousePos(e);
      const hovered = getNodeAtPosition(pos.x, pos.y);
      setHoveredNode(hovered);
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
    }
  }, [getMousePos, getNodeAtPosition]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current.moved) {
      const pos = getMousePos(e);
      const clickedNode = getNodeAtPosition(pos.x, pos.y);
      setSelectedNode(clickedNode);
    }
    
    dragStartRef.current = { x: 0, y: 0, moved: false, button: -1 };
    isDraggingRef.current = false;
  }, [getMousePos, getNodeAtPosition]);

  const handleMouseLeave = useCallback(() => {
    setHoveredNode(null);
    dragStartRef.current = { x: 0, y: 0, moved: false, button: -1 };
    isDraggingRef.current = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    const newZoom = Math.max(0.3, Math.min(3, zoomRef.current + delta));
    zoomRef.current = newZoom;
    setZoomDisplay(Math.round(newZoom * 100));
  }, []);

  const handleZoomIn = useCallback(() => {
    const newZoom = Math.min(3, zoomRef.current + 0.2);
    zoomRef.current = newZoom;
    setZoomDisplay(Math.round(newZoom * 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    const newZoom = Math.max(0.3, zoomRef.current - 0.2);
    zoomRef.current = newZoom;
    setZoomDisplay(Math.round(newZoom * 100));
  }, []);

  const handleReset = useCallback(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoomDisplay(100);
  }, []);

  const getRelatedNodes = () => {
    if (!selectedNode) return [];
    
    const relatedNodeIds = new Set<string>();
    edges.forEach((edge) => {
      if (edge.source === selectedNode.id) relatedNodeIds.add(edge.target);
      if (edge.target === selectedNode.id) relatedNodeIds.add(edge.source);
    });
    
    return nodes.filter(node => relatedNodeIds.has(node.id));
  };

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b border-border bg-surface flex-shrink-0">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <Network className="w-6 h-6 text-accent" />
              <div>
                <h1 className="text-lg font-semibold text-text">Knowledge Graph</h1>
                <p className="text-sm text-textSecondary">Scroll to zoom, drag to pan</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleZoomOut}
                className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <span className="text-sm text-textSecondary w-10 text-center">{zoomDisplay}%</span>
              <button
                onClick={handleZoomIn}
                className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
                title="Zoom In"
              >
                <ZoomIn className="w-5 h-5" />
              </button>
              <button
                onClick={handleReset}
                className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
                title="Reset"
              >
                <Maximize2 className="w-5 h-5" />
              </button>
              <div className="w-px h-6 bg-border mx-2" />
              <button
                onClick={loadGraphData}
                className="flex items-center gap-2 px-4 py-2 bg-accent/20 hover:bg-accent/30 text-accent font-medium rounded-lg transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Refresh</span>
              </button>
            </div>
          </div>
        </div>

        <div ref={containerRef} className="flex-1 bg-background relative overflow-hidden">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center">
                <Network className="w-16 h-16 text-accent/50 mb-4 animate-pulse" />
                <p className="text-textSecondary">Loading...</p>
              </div>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onWheel={handleWheel}
              className="absolute inset-0 cursor-grab"
            />
          )}
        </div>

        <div className="px-6 py-3 border-t border-border bg-surface flex-shrink-0">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-[#3B82F6]" />
              <span className="text-xs text-textSecondary">Paper</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-[#8B5CF6]" />
              <span className="text-xs text-textSecondary">Author</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-[#10B981]" />
              <span className="text-xs text-textSecondary">Topic</span>
            </div>
            <div className="w-px h-3 bg-border mx-1" />
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5 bg-[#EF4444]" />
              <span className="text-xs text-textSecondary">Cites</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5 bg-[#A855F7]" />
              <span className="text-xs text-textSecondary">Author</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5 bg-[#3B82F6]" />
              <span className="text-xs text-textSecondary">Related</span>
            </div>
          </div>
        </div>
      </div>

      {selectedNode && (
        <div className="w-64 flex-shrink-0 border-l border-border bg-surface p-4 overflow-auto">
          <div className="flex items-center gap-3 mb-4">
            <div 
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${selectedNode.color}20` }}
            >
              <Info className="w-4 h-4" style={{ color: selectedNode.color }} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-textSecondary uppercase">
                {selectedNode.type}
              </p>
              <h3 className="text-sm font-semibold text-text truncate">{selectedNode.label}</h3>
            </div>
          </div>

          <div className="mb-4">
            <h4 className="text-xs font-medium text-textSecondary mb-2">Related</h4>
            <div className="space-y-1">
              {getRelatedNodes().slice(0, 5).map((node) => (
                <div
                  key={node.id}
                  onClick={() => setSelectedNode(node)}
                  className="flex items-center gap-2 px-2 py-1.5 bg-background rounded cursor-pointer hover:bg-primary/10 transition-colors"
                >
                  <div 
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: node.color }}
                  />
                  <span className="text-xs text-text truncate">{node.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-medium text-textSecondary mb-2">Actions</h4>
            <div className="space-y-1">
              <button className="w-full px-2 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary text-xs rounded transition-colors text-left">
                View Details
              </button>
              <button className="w-full px-2 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors text-left">
                Ask AI
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GraphPage;