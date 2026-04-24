import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, List, FolderTree, Settings as SettingsIcon, Folder, Trash2, Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  useDroppable,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStorage, useMutation } from '@liveblocks/react/suspense';
import arrowPaths from "./imports/svg-hzx9ujz7s0";
import {
  Assignee,
  SectionId,
  ListId,
  AppMode,
  Task,
  Project,
  Client,
  Person,
  LIST_TITLES,
  LISTS,
  formatDeadline,
  todayISO,
} from './data';


function TaskCheckbox({ completed, onToggle }: { completed: boolean; onToggle: () => void }) {
  return (
    <motion.div className="relative shrink-0 size-3 cursor-pointer" whileTap={{ scale: 0.9 }} onClick={onToggle}>
      <div className={`absolute inset-0 rounded-[3.333px] ${completed ? 'bg-[#5e5e5e]' : ''}`}>
        <div aria-hidden="true" className={`absolute ${completed ? 'border-[#5e5e5e] border-[2.67px]' : 'border-white border-[0.667px]'} border-solid inset-0 pointer-events-none rounded-[3.333px]`} />
      </div>
      {completed && (
        <motion.div initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", duration: 0.3, bounce: 0.4 }} className="absolute inset-0 flex items-center justify-center">
          <svg className="w-2 h-2" viewBox="0 0 8 8"><path d="M6.5 1.5L3 5L1.5 3.5" stroke="#282828" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </motion.div>
      )}
    </motion.div>
  );
}

function AssigneeBadge({ letter, tone }: { letter: Assignee; tone: 'scheduled' | 'todo' }) {
  const fill = tone === 'scheduled' ? '#8465FF' : '#656464';
  return (
    <div className="relative shrink-0 size-[12.333px]" title={letter}>
      <svg className="absolute block inset-0 size-full" fill="none" viewBox="0 0 12.3333 12.3333">
        <circle cx="6.16663" cy="6.16663" fill={fill} r="6.16663" />
      </svg>
      <div className="assignee-initial absolute flex flex-col font-['Untitled_Sans:Heavy',sans-serif] font-extrabold inset-[22.22%_0_19.44%_0] justify-center leading-[0] not-italic text-[#282828] text-[7.5px] text-center">
        <p className="leading-[normal]">{letter}</p>
      </div>
    </div>
  );
}

function DeadlineArrow() {
  return (
    <div className="h-[12px] relative shrink-0 w-[18px]">
      <svg className="absolute block inset-0 size-full" fill="none" viewBox="0 0 18 12">
        <path d={arrowPaths.p25eb4200} fill="#656464" />
      </svg>
    </div>
  );
}

function SortableTaskItem({
  task, onToggle, onRename, onDelete, onEdit, isDragOverlay = false, displacementOffset = 0, insertionGap = 0, isAnyDragging = false, collapsed = false, projects = [], clients = [],
}: {
  task: Task; onToggle: () => void; onRename?: (title: string) => void; onDelete?: () => void; onEdit?: () => void; isDragOverlay?: boolean; displacementOffset?: number; insertionGap?: number; isAnyDragging?: boolean; collapsed?: boolean; projects?: Project[]; clients?: Client[];
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const client = project?.clientId ? clients.find((c) => c.id === project.clientId) : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { type: 'task', task } });
  const style = { transform: CSS.Transform.toString(transform), transition: isDragOverlay || !isAnyDragging ? 'none' : 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)' };
  const isScheduled = task.type === 'scheduled';
  const titleColor = isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#5e5e5e]' : 'text-white';
  const metaColor = isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      className={`relative shrink-0 w-full group overflow-hidden ${isDragOverlay ? 'z-50 bg-[#333333]' : task.completed ? 'bg-[#2d2d2d]' : ''}`}
      animate={{
        y: displacementOffset,
        marginTop: insertionGap,
        height: collapsed ? 0 : 37,
        scale: isDragOverlay ? 1.02 : 1,
        opacity: isDragging ? 0 : 1,
      }}
      transition={{
        y: isAnyDragging
          ? { type: "spring", stiffness: 260, damping: 32, mass: 0.8 }
          : { duration: 0 },
        marginTop: { type: "spring", stiffness: 260, damping: 32, mass: 0.8 },
        height: { type: "spring", stiffness: 220, damping: 34, mass: 0.9 },
        scale: { duration: 0.18 },
        opacity: isDragging ? { duration: 0.12, ease: "easeOut" } : { duration: 0 },
      }}
      whileHover={!isDragging && !isDragOverlay ? { backgroundColor: "rgba(255, 255, 255, 0.03)", transition: { duration: 0.15 } } : {}}
    >
      <div onDoubleClick={(e) => { if (onEdit && !editing) { e.stopPropagation(); onEdit(); } }} className="box-border flex flex-row gap-2 h-[37px] items-center px-[31px] w-full">
        <motion.div {...attributes} {...listeners} className="opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing -ml-5 p-1 text-[#5e5e5e] hover:text-white transition-all duration-200" whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}>
          <svg width="12" height="18" viewBox="0 0 12 18" fill="none">
            <path d="M6 1L6 17" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <path d="M2.5 3.5L6 0L9.5 3.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 14.5L6 18L9.5 14.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.div>
        {!isScheduled && <TaskCheckbox completed={task.completed} onToggle={onToggle} />}
        <div className="flex flex-row items-center gap-[4px]">
          {project && (
            <p className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-[#656464]`}>{project.name}</p>
          )}
          <span
            contentEditable={editing && !isDragOverlay}
            suppressContentEditableWarning
            onClick={(e) => { if (!isScheduled && onRename && !editing) { e.stopPropagation(); setEditing(true); } }}
            onPointerDown={(e) => { if (editing) e.stopPropagation(); }}
            onBlur={(e) => {
              const next = (e.currentTarget.textContent || '').trim();
              if (onRename && next && next !== task.title) onRename(next);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLSpanElement).blur(); }
              if (e.key === 'Escape') { e.preventDefault(); (e.currentTarget as HTMLSpanElement).textContent = task.title; setEditing(false); }
            }}
            className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap outline-none ${titleColor} ${!isScheduled && onRename ? 'cursor-text' : ''}`}
          >{task.title}</span>
          {client && (
            <p className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap ${metaColor}`}>{client.short}</p>
          )}
        </div>
        {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} />)}
        {task.deadline && (
          <>
            {!isScheduled && <DeadlineArrow />}
            <p className={`font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] whitespace-nowrap ${isScheduled ? 'text-[#8465ff]' : 'text-white'}`}>{formatDeadline(task.deadline)}</p>
          </>
        )}
        {onDelete && !isDragOverlay && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
            aria-label="Delete task"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
      <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[#656464] text-[14px] whitespace-nowrap">{title}</p>
    </div>
  );
}

function Spacer() { return <div className="h-[37px] shrink-0 w-full" />; }

function SectionDroppable({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`min-h-[37px] w-full transition-colors ${isOver ? 'bg-white/[0.02]' : ''}`}>
      {children}
    </div>
  );
}

function BottomBar({ mode, onSetMode, onAdd }: { mode: AppMode; onSetMode: (m: AppMode) => void; onAdd: () => void }) {
  const iconClass = (active: boolean) => `p-2 rounded-full transition-colors ${active ? 'text-white' : 'text-[#656464] hover:text-white'}`;
  return (
    <div className="fixed bottom-0 left-0 right-0 h-[109px] bg-[#232323] flex items-center px-14 z-40">
      <div className="flex-1 grid grid-cols-5 gap-5 items-center max-w-[600px]">
        <motion.button onClick={onAdd} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }} className="size-[57px] rounded-full bg-[#7363FF] flex items-center justify-center shadow-lg">
          <Plus size={22} color="#232323" strokeWidth={2.5} />
        </motion.button>
        <button onClick={() => onSetMode('dashboard')} className={iconClass(mode === 'dashboard')}><List size={22} /></button>
        <button onClick={() => onSetMode('projectView')} className={iconClass(mode === 'projectView')}><FolderTree size={22} /></button>
        <button onClick={() => onSetMode('calendar')} className={iconClass(mode === 'calendar')}><CalendarIcon size={22} /></button>
        <button onClick={() => onSetMode('settings')} className={iconClass(mode === 'settings')}><SettingsIcon size={22} /></button>
      </div>
    </div>
  );
}

function DateRangePicker({ start, end, onChange }: { start?: string; end?: string; onChange: (s?: string, e?: string) => void }) {
  const [viewMonth, setViewMonth] = useState(() => {
    const base = start || end || todayISO();
    const [y, m] = base.split('-').map(Number);
    return { y, m };
  });
  const [hoverIso, setHoverIso] = useState<string | null>(null);

  const daysInMonth = new Date(viewMonth.y, viewMonth.m, 0).getDate();
  const firstDay = new Date(viewMonth.y, viewMonth.m - 1, 1).getDay();
  const monthName = new Date(viewMonth.y, viewMonth.m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const iso = (d: number) => `${viewMonth.y}-${String(viewMonth.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const pick = (d: number) => {
    const picked = iso(d);
    if (!start || (start && end)) {
      onChange(picked, undefined);
    } else {
      if (picked < start) onChange(picked, start);
      else if (picked === start) onChange(undefined, undefined);
      else onChange(start, picked);
    }
  };

  const prevMonth = () => setViewMonth(({ y, m }) => m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });
  const nextMonth = () => setViewMonth(({ y, m }) => m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });

  const inRange = (d: number) => {
    const cur = iso(d);
    const hovering = start && !end && hoverIso;
    const rangeEnd = end || (hovering && hoverIso >= start ? hoverIso : undefined);
    const rangeStart = start && hovering && hoverIso < start ? hoverIso : start;
    if (!rangeStart || !rangeEnd) return false;
    return cur >= rangeStart && cur <= rangeEnd;
  };

  return (
    <div className="bg-[#1f1f1f] rounded-md p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={prevMonth} className="text-[#888] hover:text-white px-2">‹</button>
        <div className="text-white text-[13px]">{monthName}</div>
        <button type="button" onClick={nextMonth} className="text-[#888] hover:text-white px-2">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[11px] text-[#666] mb-1">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDay }).map((_, i) => <div key={`b${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
          const cur = iso(d);
          const isStart = start === cur;
          const isEnd = end === cur;
          const isInRange = inRange(d);
          const isEdge = isStart || isEnd;
          return (
            <button
              key={d}
              type="button"
              onClick={() => pick(d)}
              onMouseEnter={() => setHoverIso(cur)}
              onMouseLeave={() => setHoverIso(null)}
              className={`h-7 rounded text-[12px] transition-colors ${isEdge ? 'bg-[#7363FF] text-white' : isInRange ? 'bg-[#7363FF]/30 text-white' : 'text-[#ccc] hover:bg-[#333]'}`}
            >{d}</button>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-2 text-[11px]">
        <div className="text-[#888]">
          {start && <span>{formatDeadline(start)}</span>}
          {start && end && <span className="mx-1">→</span>}
          {end && <span>{formatDeadline(end)}</span>}
          {!start && !end && <span>Pick start, then end</span>}
        </div>
        {(start || end) && (
          <button type="button" onClick={() => onChange(undefined, undefined)} className="text-[#888] hover:text-white">Clear</button>
        )}
      </div>
    </div>
  );
}

function AddModal({
  onClose, onAddTask, onUpdateTask, onAddProject, onAddClient, projects, clients, people, editingTask, defaultList,
}: {
  onClose: () => void;
  onAddTask: (t: Omit<Task, 'id' | 'order'>) => void;
  onUpdateTask?: (id: string, patch: Partial<Omit<Task, 'id' | 'order'>>) => void;
  onAddProject: (p: Omit<Project, 'id'>) => void;
  onAddClient: (c: Omit<Client, 'id'>) => void;
  projects: Project[]; clients: Client[]; people: Person[];
  editingTask?: Task | null;
  defaultList?: ListId;
}) {
  const isEdit = !!editingTask;
  const initialProject = editingTask?.projectId ? projects.find((p) => p.id === editingTask.projectId) : undefined;
  const [tab, setTab] = useState<'task' | 'project' | 'client'>('task');
  const [title, setTitle] = useState(editingTask?.title ?? '');
  const [list, setList] = useState<ListId>(editingTask?.list ?? defaultList ?? 'dashboard');
  const [section, setSection] = useState<SectionId>(editingTask?.section ?? 'today');
  const [clientId, setClientId] = useState<string>(initialProject?.clientId ?? '');
  const [projectId, setProjectId] = useState<string>(editingTask?.projectId ?? '');
  const [assignees, setAssignees] = useState<string[]>(editingTask?.assignees ?? []);
  const [startDate, setStartDate] = useState<string | undefined>(editingTask?.startDate);
  const [deadline, setDeadline] = useState<string | undefined>(editingTask?.deadline);
  const [projectName, setProjectName] = useState('');
  const [projectClient, setProjectClient] = useState<string>('');
  const [clientName, setClientName] = useState('');

  const filteredProjects = useMemo(() => clientId ? projects.filter((p) => p.clientId === clientId) : projects, [projects, clientId]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'task' && title.trim()) {
      if (isEdit && editingTask && onUpdateTask) {
        onUpdateTask(editingTask.id, {
          title: title.trim(),
          assignees,
          list,
          section,
          projectId: projectId || undefined,
          startDate,
          deadline,
        });
      } else {
        onAddTask({
          title: title.trim(),
          type: 'todo',
          assignees,
          completed: false,
          list,
          section,
          projectId: projectId || undefined,
          startDate,
          deadline,
        });
      }
      onClose();
    } else if (tab === 'project' && projectName.trim()) {
      onAddProject({ name: projectName.trim(), clientId: projectClient || undefined });
      onClose();
    } else if (tab === 'client' && clientName.trim()) {
      onAddClient({ name: clientName.trim(), short: '' });
      onClose();
    }
  };

  const toggleAssignee = (short: string) => {
    setAssignees((prev) => prev.includes(short) ? prev.filter((s) => s !== short) : [...prev, short]);
  };

  const tabBtn = (id: typeof tab, label: string) => (
    <button type="button" onClick={() => setTab(id)} className={`px-4 py-2 text-[14px] rounded-md transition-colors ${tab === id ? 'bg-[#7363FF] text-white' : 'text-[#999] hover:text-white'}`}>{label}</button>
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }} onClick={(e) => e.stopPropagation()} className="bg-[#2a2a2a] rounded-2xl border border-[#3a3a3a] w-[520px] p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-1">
            {isEdit ? <div className="px-4 py-2 text-[14px] text-white">Edit Task</div> : <>{tabBtn('task', 'Task')}{tabBtn('project', 'Project')}{tabBtn('client', 'Client')}</>}
          </div>
          <button onClick={onClose} className="text-[#888] hover:text-white p-1"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {tab === 'task' && (
            <>
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title (required)" className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#7363FF]" />
              <div className="flex gap-2">
                <select value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(''); }} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  <option value="">No client</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  <option value="">No project</option>
                  {filteredProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <select value={list} onChange={(e) => setList(e.target.value as ListId)} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  {LISTS.map((l) => <option key={l} value={l}>{LIST_TITLES[l]}</option>)}
                </select>
                <select value={section} onChange={(e) => setSection(e.target.value as SectionId)} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  <option value="inbox">Inbox</option>
                  <option value="today">Today</option>
                  <option value="next">Next</option>
                </select>
              </div>
              <div>
                <div className="text-[#888] text-[12px] mb-1">Assignees</div>
                <div className="flex flex-wrap gap-2">
                  {people.map((p) => {
                    const active = assignees.includes(p.short);
                    return (
                      <button key={p.id} type="button" onClick={() => toggleAssignee(p.short)} className={`px-3 py-1 rounded-full text-[13px] transition-colors ${active ? 'bg-[#7363FF] text-white' : 'bg-[#1f1f1f] text-[#ccc] hover:bg-[#333]'}`}>
                        {p.name} <span className="opacity-70">({p.short})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="text-[#888] text-[12px] mb-1">Dates (optional — start → deadline)</div>
                <DateRangePicker start={startDate} end={deadline} onChange={(s, e) => { setStartDate(s); setDeadline(e); }} />
              </div>
            </>
          )}
          {tab === 'project' && (
            <>
              <input autoFocus value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name" className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#7363FF]" />
              <select value={projectClient} onChange={(e) => setProjectClient(e.target.value)} className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                <option value="">No client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          )}
          {tab === 'client' && (
            <input autoFocus value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client name" className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#7363FF]" />
          )}
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-[#999] hover:text-white text-[14px]">Cancel</button>
            <button type="submit" className="px-4 py-2 rounded-md bg-[#7363FF] text-white text-[14px] hover:bg-[#8573ff]">{isEdit ? 'Save' : 'Add'}</button>
          </div>
          <p className="text-[#666] text-[12px] mt-1">Projects referenced: {projects.length} · Clients: {clients.length}</p>
        </form>
      </motion.div>
    </motion.div>
  );
}

function EditableText({ value, onChange, className, autoFocus = false, placeholder, onEditingChange }: { value: string; onChange: (v: string) => void; className?: string; autoFocus?: boolean; placeholder?: string; onEditingChange?: (editing: boolean) => void }) {
  const [editing, setEditingState] = useState(autoFocus);
  const setEditing = (v: boolean) => { setEditingState(v); onEditingChange?.(v); };
  useEffect(() => { if (autoFocus) onEditingChange?.(true); }, []);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [autoFocus]);
  return (
    <span
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder={placeholder || ''}
      onClick={() => setEditing(true)}
      onBlur={(e) => {
        const next = (e.currentTarget.textContent || '').trim();
        if (next && next !== value) onChange(next);
        else if (!next && value) e.currentTarget.textContent = value;
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLSpanElement).blur(); }
        if (e.key === 'Escape') { e.preventDefault(); (e.currentTarget as HTMLSpanElement).textContent = value; setEditing(false); }
      }}
      className={`outline-none cursor-text ${className || ''}`}
      style={value ? undefined : { minWidth: '1px' }}
    >{value || (placeholder && !editing ? <span className="text-[#5e5e5e]">{placeholder}</span> : null)}</span>
  );
}

function SettingsRow({ children }: { children: React.ReactNode }) {
  return <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">{children}</div>;
}

function AddPlus({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity"><Plus size={14} /></button>
  );
}

function TrashBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white"><Trash2 size={14} /></button>
  );
}

function ShortInBrackets({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cls = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-white";
  return (
    <span className="inline-flex items-baseline">
      <span className={cls}>(</span>
      <EditableText value={value} onChange={onChange} className={cls} />
      <span className={cls}>)</span>
    </span>
  );
}

function ClientRow({ client, autoFocus, bodyFont, onRenameName, onRenameShort, onDelete }: { client: Client; autoFocus: boolean; bodyFont: string; onRenameName: (v: string) => void; onRenameShort: (v: string) => void; onDelete: () => void }) {
  const [editingName, setEditingName] = useState(autoFocus);
  return (
    <SettingsRow>
      <span className="inline-flex items-baseline">
        <EditableText value={client.name} onChange={onRenameName} className={`${bodyFont} text-white`} autoFocus={autoFocus} placeholder="New Client" onEditingChange={setEditingName} />
        {!editingName && client.short && (
          <>
            <span className="w-[6px]" />
            <ShortInBrackets value={client.short} onChange={onRenameShort} />
          </>
        )}
      </span>
      <TrashBtn onClick={onDelete} />
    </SettingsRow>
  );
}

function ProjectViewMode({
  projects, clients, tasks, newId, isAnyDragging, isDraggingProjTask, activeProjTaskId, sourceCollapsed,
  onAddClient, onRenameClient, onRenameClientShort, onDeleteClient,
  onAddProject, onRenameProject, onDeleteProject,
  onToggleTask, onRenameTask, onAddTaskToProject, onAddTaskInList,
}: {
  projects: Project[]; clients: Client[]; tasks: Task[]; newId: string | null; isAnyDragging: boolean;
  isDraggingProjTask: boolean;
  activeProjTaskId: string | null;
  sourceCollapsed: boolean;
  onToggleTask: (id: string) => void;
  onRenameTask: (id: string, title: string) => void;
  onAddTaskToProject: (projectId: string) => void;
  onAddTaskInList: (listId: ListId) => void;
  onAddClient: () => void;
  onRenameClient: (id: string, name: string) => void;
  onRenameClientShort: (id: string, short: string) => void;
  onDeleteClient: (id: string) => void;
  onAddProject: (clientId?: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
}) {
  const sortedClients = [...clients].sort((a, b) => a.name.localeCompare(b.name));
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";

  const Header = ({ title, onAdd }: { title: string; onAdd?: () => void }) => (
    <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[50px]">
      <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">{title}</p>
      {onAdd && <AddPlus onClick={onAdd} />}
    </div>
  );

  const ClientSubHeader = ({ client }: { client: Client }) => (
    <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
      <p className={`${bodyFont} text-[#656464]`}>{client.name}</p>
      <AddPlus onClick={() => onAddProject(client.id)} />
    </div>
  );

  const tasksForProjectList = (p: Project, listId: ListId) => tasks.filter((t) => t.list === listId && (t.projectId === p.id || (!t.projectId && (t.title.toLowerCase().startsWith(p.name.toLowerCase() + '-') || t.title.toLowerCase() === p.name.toLowerCase()))));

  const renderListColumn = (listId: ListId, title: string) => {
    // Tasks already shown under some project (either matched by projectId or by legacy title heuristic)
    const claimed = new Set<string>();
    for (const p of projects) for (const t of tasksForProjectList(p, listId)) claimed.add(t.id);
    const unassigned = tasks.filter((t) => t.list === listId && !t.projectId && !claimed.has(t.id));
    const noClientProjects = projects.filter((p) => !p.clientId && (p.list ? p.list === listId : tasksForProjectList(p, listId).length > 0));
    return (
    <div key={listId} className="flex-1 min-w-[340px] max-w-[440px]">
      <Header title={title} onAdd={() => onAddTaskInList(listId)} />
      {unassigned.length > 0 && (
        <div className="mb-[37px]">
          <SortableContext items={unassigned.map((t) => `projtask-${listId}-${t.id}`)} strategy={verticalListSortingStrategy}>
            {unassigned.map((t) => (
              <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} isAnyDragging={isAnyDragging} autoFocus={t.id === newId} collapsed={sourceCollapsed && activeProjTaskId === t.id} />
            ))}
          </SortableContext>
        </div>
      )}
      {noClientProjects.length > 0 && (
        <div className="mb-[37px]">
          <SortableContext items={noClientProjects.map((p) => `projrow-${listId}-${p.id}`)} strategy={verticalListSortingStrategy}>
            {noClientProjects.map((p) => {
              const projTasks = tasksForProjectList(p, listId);
              return (
                <div key={p.id}>
                  <SortableProjectRow project={p} listId={listId} onRename={onRenameProject} onDelete={onDeleteProject} onAddTask={onAddTaskToProject} autoFocus={p.id === newId} isAnyDragging={isAnyDragging} />
                  <SortableContext items={projTasks.map((t) => `projtask-${listId}-${t.id}`)} strategy={verticalListSortingStrategy}>
                    {projTasks.map((t) => (
                      <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} isAnyDragging={isAnyDragging} autoFocus={t.id === newId} collapsed={sourceCollapsed && activeProjTaskId === t.id} />
                    ))}
                  </SortableContext>
                </div>
              );
            })}
          </SortableContext>
        </div>
      )}
      {sortedClients.map((c, ci) => {
        const clientProjects = projects.filter((p) => p.clientId === c.id);
        const visibleProjects = listId === 'projects' || isDraggingProjTask
          ? clientProjects
          : clientProjects.filter((p) => tasksForProjectList(p, listId).length > 0);
        if (visibleProjects.length === 0) return null;
        return (
          <div key={c.id}>
            {ci > 0 && <Spacer />}
            <ClientSubHeader client={c} />
            <SortableContext items={visibleProjects.map((p) => `projrow-${listId}-${p.id}`)} strategy={verticalListSortingStrategy}>
              {visibleProjects.map((p) => {
                const projTasks = tasksForProjectList(p, listId);
                return (
                  <div key={p.id}>
                    <SortableProjectRow project={p} listId={listId} onRename={onRenameProject} onDelete={onDeleteProject} onAddTask={onAddTaskToProject} autoFocus={p.id === newId} isAnyDragging={isAnyDragging} />
                    <SortableContext items={projTasks.map((t) => `projtask-${listId}-${t.id}`)} strategy={verticalListSortingStrategy}>
                      {projTasks.map((t) => (
                        <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} isAnyDragging={isAnyDragging} autoFocus={t.id === newId} collapsed={sourceCollapsed && activeProjTaskId === t.id} />
                      ))}
                    </SortableContext>
                  </div>
                );
              })}
            </SortableContext>
          </div>
        );
      })}
    </div>
    );
  };

  return (
    <div className="pt-[106px] pb-[140px] flex gap-0 min-w-[1760px]">
      <div className="flex-1 min-w-[340px] max-w-[440px]">
        <Header title="Clients" onAdd={onAddClient} />
        {sortedClients.map((c) => (
          <ClientRow key={c.id} client={c} autoFocus={c.id === newId} bodyFont={bodyFont} onRenameName={(v) => onRenameClient(c.id, v)} onRenameShort={(v) => onRenameClientShort(c.id, v)} onDelete={() => onDeleteClient(c.id)} />
        ))}
      </div>
      {renderListColumn('work', 'Work')}
      {renderListColumn('projects', 'Projects')}
      {renderListColumn('admin', 'Admin')}
    </div>
  );
}

function startOfWeek(d: Date): Date {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  nd.setDate(nd.getDate() - nd.getDay());
  return nd;
}
function addDaysToDate(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dateToISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarDayDroppable({ id, children, isEmpty, className = '' }: { id: string; children: React.ReactNode; isEmpty: boolean; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`transition-colors ${isEmpty ? 'min-h-[37px]' : ''} ${isOver ? 'bg-white/[0.03]' : ''} ${className}`}>
      {children}
    </div>
  );
}

function CalendarColumnDroppable({ date, children }: { date: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `col:${date}`, data: { type: 'column', date } });
  return (
    <div ref={setNodeRef} className="min-w-[200px] border-r border-[#333333] last:border-r-0 flex flex-col">
      {children}
      <div className="flex-1 min-h-[100px]" />
    </div>
  );
}

const CAL_LISTS: { id: ListId; label: string }[] = [
  { id: 'admin', label: 'Admin' },
  { id: 'work', label: 'Work' },
  { id: 'projects', label: 'Projects' },
];

function CalendarCard({ task, cellId, projects, clients, onToggle, onRename, onDelete, onEdit, isAnyDragging, dimmed }: {
  task: Task; cellId: string; projects: Project[]; clients: Client[];
  onToggle: () => void; onRename: (title: string) => void; onDelete: () => void; onEdit: () => void;
  isAnyDragging: boolean; dimmed?: boolean;
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const client = project?.clientId ? clients.find((c) => c.id === project.clientId) : undefined;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { type: 'task', task, calendarCellId: cellId } });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? transition : 'none' };
  const isScheduled = task.type === 'scheduled';
  const titleColor = task.completed ? 'text-[#5e5e5e] line-through' : isScheduled ? 'text-[#8465ff]' : 'text-white';
  const metaColor = isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
  return (
    <div ref={setNodeRef} style={style} className={`relative mx-[6px] mb-[4px] rounded-md bg-[#333333] group ${dimmed ? 'opacity-60' : ''} ${isDragging ? 'opacity-0' : ''}`}>
      <div onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }} {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing px-[10px] py-[6px] flex flex-col gap-[2px]">
        <div className="flex flex-row items-center gap-[4px]">
          {!isScheduled && (
            <div onPointerDown={(e) => e.stopPropagation()}>
              <TaskCheckbox completed={task.completed} onToggle={onToggle} />
            </div>
          )}
          {project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis text-[#656464]`}>{project.name}</p>}
          <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}>{task.title}</span>
        </div>
        <div className="flex flex-row items-center gap-[6px] pl-[20px]">
          {client && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${metaColor}`}>{client.short}</p>}
          {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} />)}
          {task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap ${isScheduled ? 'text-[#8465ff]' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
        </div>
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-1 right-1 p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
        aria-label="Delete task"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function WeekCalendarMode({
  tasks, projects, clients, onToggleTask, onRenameTask, onDeleteTask, onEditTask, isAnyDragging,
}: {
  tasks: Task[]; projects: Project[]; clients: Client[];
  onToggleTask: (id: string) => void;
  onRenameTask: (id: string, title: string) => void;
  onDeleteTask: (id: string) => void;
  onEditTask: (t: Task) => void;
  isAnyDragging: boolean;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const base = startOfWeek(new Date());
  const weekStart = addDaysToDate(base, weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDaysToDate(weekStart, i));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const todayIso = dateToISO(new Date());

  const todayAnchor = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const dayOffsetFromToday = (d: Date) => Math.round((d.getTime() - todayAnchor.getTime()) / 86400000);
  const PER_DAY_CAP = 12;

  const tasksForCell = (listId: ListId, d: Date): Task[] => {
    const off = dayOffsetFromToday(d);
    const iso = dateToISO(d);
    if (off === 0) {
      return tasks.filter((t) => t.list === listId && t.section === 'today').sort((a, b) => a.order - b.order);
    }
    if (off > 0) {
      const nextBucket = tasks.filter((t) => t.list === listId && t.section === 'next').sort((a, b) => a.order - b.order);
      const start = (off - 1) * PER_DAY_CAP;
      return nextBucket.slice(start, start + PER_DAY_CAP);
    }
    // Past days: completed tasks whose deadline matches this day
    return tasks.filter((t) => t.list === listId && t.completed && t.deadline === iso).sort((a, b) => a.order - b.order);
  };

  const formatRange = () => {
    const end = addDaysToDate(weekStart, 6);
    const mon = weekStart.toLocaleDateString('en-US', { month: 'short' });
    const monEnd = end.toLocaleDateString('en-US', { month: 'short' });
    return mon === monEnd
      ? `${mon} ${weekStart.getDate()}–${end.getDate()}, ${end.getFullYear()}`
      : `${mon} ${weekStart.getDate()} – ${monEnd} ${end.getDate()}, ${end.getFullYear()}`;
  };

  return (
    <div className="pt-[106px] pb-[140px] px-[35px] min-w-[1400px]">
      <div className="flex items-center gap-3 mb-[37px]">
        <button onClick={() => setWeekOffset((o) => o - 1)} className="p-1 text-[#656464] hover:text-white transition-colors"><ChevronLeft size={20} /></button>
        <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">{formatRange()}</p>
        <button onClick={() => setWeekOffset((o) => o + 1)} className="p-1 text-[#656464] hover:text-white transition-colors"><ChevronRight size={20} /></button>
        {weekOffset !== 0 && (
          <button onClick={() => setWeekOffset(0)} className={`${bodyFont} text-[#656464] hover:text-white ml-2 transition-colors`}>Today</button>
        )}
      </div>
      <div className="grid grid-cols-7 gap-0">
        {days.map((d, i) => {
          const iso = dateToISO(d);
          const isToday = iso === todayIso;
          return (
            <CalendarColumnDroppable key={iso} date={iso}>
              <div className={`h-[37px] flex items-baseline gap-2 px-[16px] mb-[12px] ${i === 0 || i === 6 ? 'text-[#656464]' : 'text-white'}`}>
                <p className="font-['NB_International:Regular',sans-serif]">{dayNames[i]}</p>
                <p className={bodyFont}>{d.getDate()}</p>
                {isToday && <p className="text-[#8465ff]">(Today)</p>}
              </div>
              {CAL_LISTS.map(({ id: listId, label }) => {
                const bucket = tasksForCell(listId, d);
                const items = bucket.map((t) => t.id);
                const isPast = dayOffsetFromToday(d) < 0;
                return (
                  <CalendarDayDroppable key={listId} id={`cal:${iso}:${listId}`} isEmpty={bucket.length === 0} className="pb-[37px] last:pb-0">
                    <div className="h-[20px] px-[16px] flex items-center mb-[6px]">
                      <p className={`${bodyFont} text-[#5e5e5e]`}>{label}</p>
                    </div>
                    <SortableContext items={items} strategy={verticalListSortingStrategy}>
                        {bucket.map((t) => (
                          <CalendarCard
                            key={t.id}
                            task={t}
                            cellId={`cal:${iso}:${listId}`}
                            onToggle={() => onToggleTask(t.id)}
                            onRename={(title) => onRenameTask(t.id, title)}
                            onDelete={() => onDeleteTask(t.id)}
                            onEdit={() => onEditTask(t)}
                            isAnyDragging={isAnyDragging}
                            dimmed={isPast}
                            projects={projects}
                            clients={clients}
                          />
                        ))}
                    </SortableContext>
                  </CalendarDayDroppable>
                );
              })}
            </CalendarColumnDroppable>
          );
        })}
      </div>
    </div>
  );
}

function SettingsMode({ people, newId, onAddPerson, onRenamePerson, onRenamePersonShort, onDeletePerson, currentUserShort, onSetCurrentUser }: {
  people: Person[]; newId: string | null;
  onAddPerson: () => void;
  onRenamePerson: (id: string, name: string) => void;
  onRenamePersonShort: (id: string, short: string) => void;
  onDeletePerson: (id: string) => void;
  currentUserShort: string;
  onSetCurrentUser: (short: string) => void;
}) {
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  return (
    <div className="pt-[106px] pb-[140px] flex gap-0 min-w-[1760px]">
      <div className="flex-1 min-w-[340px] max-w-[440px]">
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[20px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">I am</p>
        </div>
        <div className="px-[31px] mb-[50px] flex flex-wrap gap-2">
          {people.map((p) => {
            const active = p.short === currentUserShort;
            return (
              <button key={p.id} type="button" onClick={() => onSetCurrentUser(p.short)} className={`px-3 py-1 rounded-full text-[13px] transition-colors ${active ? 'bg-[#7363FF] text-white' : 'bg-[#1f1f1f] text-[#ccc] hover:bg-[#333]'}`}>
                {p.name || '(unnamed)'} <span className="opacity-70">({p.short || '?'})</span>
              </button>
            );
          })}
          {people.length === 0 && <span className="text-[#666] text-[12px]">Add a person below first.</span>}
        </div>
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[50px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">People</p>
          <AddPlus onClick={onAddPerson} />
        </div>
        {people.map((p) => (
          <SettingsRow key={p.id}>
            <span className="inline-flex items-baseline">
              <EditableText value={p.name} onChange={(v) => onRenamePerson(p.id, v)} className={`${bodyFont} text-white`} autoFocus={p.id === newId} placeholder="New Person" />
              {p.short && (
                <>
                  <span className="w-[6px]" />
                  <ShortInBrackets value={p.short} onChange={(v) => onRenamePersonShort(p.id, v)} />
                </>
              )}
            </span>
            <TrashBtn onClick={() => onDeletePerson(p.id)} />
          </SettingsRow>
        ))}
      </div>
    </div>
  );
}

function SortableProjectRow({ project, listId, onRename, onDelete, onAddTask, autoFocus, isAnyDragging }: { project: Project; listId: ListId; onRename: (id: string, name: string) => void; onDelete: (id: string) => void; onAddTask: (projectId: string) => void; autoFocus?: boolean; isAnyDragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `projrow-${listId}-${project.id}`, data: { type: 'project', project, listId } });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none', opacity: isDragging ? 0 : 1 };
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  return (
    <motion.div ref={setNodeRef} style={style} className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing flex items-center">
        <Folder size={12} className="text-[#656464]" />
      </div>
      <EditableText value={project.name} onChange={(v) => onRename(project.id, v)} className={`${bodyFont} text-white`} autoFocus={autoFocus} placeholder="New Project" />
      <AddPlus onClick={() => onAddTask(project.id)} />
      <TrashBtn onClick={() => onDelete(project.id)} />
    </motion.div>
  );
}

function LIndent() {
  return (
    <div className="shrink-0 w-[12px] h-[12px] flex items-end justify-start">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 0 L2 8 L10 8" stroke="#656464" strokeWidth="1" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function ProjectTaskRow({ task, listId, onToggle, onRename, isAnyDragging, autoFocus, collapsed }: { task: Task; listId: ListId; onToggle: () => void; onRename: (t: string) => void; isAnyDragging?: boolean; autoFocus?: boolean; collapsed?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `projtask-${listId}-${task.id}`, data: { type: 'projTask', task, listId } });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none' };
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const titleColor = task.completed ? 'text-[#5e5e5e]' : 'text-white';
  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      className="relative shrink-0 w-full group overflow-hidden"
      animate={{ height: collapsed ? 0 : 37, opacity: isDragging ? 0 : 1 }}
      transition={{ height: { type: 'spring', stiffness: 220, damping: 34, mass: 0.9 }, opacity: { duration: 0.12, ease: 'easeOut' } }}
    ><div className="box-border flex flex-row gap-2 h-[37px] items-center pl-[43px] pr-[31px] w-full">
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing flex items-center opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity">
        <svg width="10" height="14" viewBox="0 0 12 18" fill="none">
          <path d="M6 1L6 17" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path d="M2.5 3.5L6 0L9.5 3.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2.5 14.5L6 18L9.5 14.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <LIndent />
      <TaskCheckbox completed={task.completed} onToggle={onToggle} />
      <EditableText value={task.title} onChange={onRename} autoFocus={autoFocus} placeholder="New Task" className={`${bodyFont} ${titleColor} ${task.completed ? 'line-through' : ''}`} />
      </div>
    </motion.div>
  );
}

type StorageKey = 'tasks' | 'projects' | 'clients' | 'people';

function useStorageList<K extends StorageKey, T>(key: K) {
  const value = useStorage((root) => (root as any)[key]) as T[];
  const setter = useMutation(({ storage }, updater: T[] | ((prev: T[]) => T[])) => {
    const current = storage.get(key as any) as T[];
    const next = typeof updater === 'function' ? (updater as (p: T[]) => T[])(current) : updater;
    storage.set(key as any, next as any);
  }, []);
  return [value, setter] as const;
}

export default function App() {
  const [tasks, setTasks] = useStorageList<'tasks', Task>('tasks');
  const [projects, setProjects] = useStorageList<'projects', Project>('projects');
  const [clients, setClients] = useStorageList<'clients', Client>('clients');
  const [people, setPeople] = useStorageList<'people', Person>('people');
  const [mode, setMode] = useState<AppMode>('dashboard');
  const [showAdd, setShowAdd] = useState(false);
  const [prefillList, setPrefillList] = useState<ListId | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'task' | 'project' | 'projTask' | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeProjTask, setActiveProjTask] = useState<Task | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [activeRectWidth, setActiveRectWidth] = useState<number | undefined>(undefined);
  const [columnOffset, setColumnOffset] = useState(0);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOffsetRef = useRef<number>(0);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startXRef = useRef<number | null>(null);
  const ctrlDownRef = useRef(false);
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.ctrlKey || e.metaKey) ctrlDownRef.current = true; };
    const up = (e: KeyboardEvent) => { if (!e.ctrlKey && !e.metaKey) ctrlDownRef.current = false; };
    const blur = () => { ctrlDownRef.current = false; };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);

  // Auto-promote tasks to 'today' when their start date arrives
  useEffect(() => {
    const today = todayISO();
    const needsPromote = tasks.some((t) => t.startDate && t.startDate <= today && t.section === 'next');
    if (needsPromote) {
      setTasks((prev) => prev.map((t) => (t.startDate && t.startDate <= today && t.section === 'next' ? { ...t, section: 'today' as SectionId } : t)));
    }
  }, [tasks, setTasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const measuringConfig = { droppable: { strategy: MeasuringStrategy.Always } };

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
  }, []);

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const renameTask = useCallback((id: string, title: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  const addTask = useCallback((t: Omit<Task, 'id' | 'order'>) => {
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === t.list && x.section === t.section).reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { ...t, id: `task-${Date.now()}`, order: maxOrder + 1 }];
    });
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<Omit<Task, 'id' | 'order'>>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const addProject = useCallback((p: Omit<Project, 'id'>) => setProjects((prev) => [...prev, { ...p, id: `p-${Date.now()}` }]), []);
  const addTaskToProject = useCallback((projectId: string) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === 'projects' && x.section === 'today').reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { id, title: '', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'today', order: maxOrder + 1, projectId }];
    });
    setNewId(id);
  }, []);
  const addClient = useCallback((c: Omit<Client, 'id'>) => setClients((prev) => [...prev, { ...c, id: `c-${Date.now()}` }]), []);
  const [newId, setNewId] = useState<string | null>(null);
  const addBlankClient = useCallback(() => {
    const id = `c-${Date.now()}`;
    setClients((prev) => [...prev, { id, name: '', short: '' }]);
    setNewId(id);
  }, []);
  const addBlankProject = useCallback((clientId?: string, list?: ListId) => {
    const id = `p-${Date.now()}`;
    setProjects((prev) => [...prev, { id, name: '', clientId, list }]);
    setNewId(id);
  }, []);
  const addPerson = useCallback(() => setPeople((prev) => [...prev, { id: `pr-${Date.now()}`, name: 'New Person', short: '?' }]), []);
  const deleteProject = useCallback((id: string) => setProjects((prev) => prev.filter((p) => p.id !== id)), []);
  const deleteClient = useCallback((id: string) => setClients((prev) => prev.filter((c) => c.id !== id)), []);
  const renameProject = useCallback((id: string, name: string) => setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p))), []);
  const contractName = useCallback((name: string): string => {
    const trimmed = name.trim();
    if (trimmed.length <= 6) return trimmed;
    const words = trimmed.split(/\s+/);
    if (words.length > 1) {
      const initials = words.map((w) => w[0]?.toUpperCase() || '').join('');
      if (initials.length <= 6) return initials;
      return initials.slice(0, 6);
    }
    const first = trimmed[0];
    const rest = trimmed.slice(1).replace(/[aeiou]/gi, '');
    const condensed = first + rest;
    return condensed.slice(0, 6);
  }, []);
  const renameClient = useCallback((id: string, name: string) => setClients((prev) => prev.map((c) => {
    if (c.id !== id) return c;
    const shouldAutoShort = id === newId || !c.short;
    return { ...c, name, short: shouldAutoShort ? contractName(name) : c.short };
  })), [newId, contractName]);
  const renameClientShort = useCallback((id: string, short: string) => {
    setClients((prev) => prev.map((c) => (c.id === id ? { ...c, short } : c)));
  }, []);
  const renamePerson = useCallback((id: string, name: string) => setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p))), []);
  const renamePersonShort = useCallback((id: string, short: string) => {
    setPeople((prev) => {
      const prior = prev.find((p) => p.id === id)?.short;
      if (prior && prior !== short) {
        setTasks((ts) => ts.map((t) => ({ ...t, assignees: t.assignees.map((a) => (a === prior ? short : a)) as typeof t.assignees })));
      }
      return prev.map((p) => (p.id === id ? { ...p, short } : p));
    });
  }, []);
  const deletePerson = useCallback((id: string) => setPeople((prev) => prev.filter((p) => p.id !== id)), []);

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const type = e.active.data.current?.type;
    if (type === 'project') {
      setActiveId(e.active.id as string);
      setActiveType('project');
      setActiveProject(e.active.data.current?.project as Project);
      const rect = e.active.rect.current.initial;
      if (rect) setActiveRectWidth(rect.width);
      return;
    }
    if (type === 'projTask') {
      setActiveId(e.active.id as string);
      setActiveType('projTask');
      setActiveProjTask(e.active.data.current?.task as Task);
      const rect = e.active.rect.current.initial;
      if (rect) setActiveRectWidth(rect.width);
      return;
    }
    setActiveId(e.active.id as string);
    setActiveType('task');
    const rect = e.active.rect.current.initial;
    if (rect) setActiveRectWidth(rect.width);
    setColumnOffset(0);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const onMove = (ev: PointerEvent) => {
      if (startXRef.current === null) startXRef.current = ev.clientX;
      const colWidth = activeRectWidth || 440;
      const deadZone = colWidth * 0.5;
      const raw = ev.clientX - startXRef.current;
      let target = 0;
      if (Math.abs(raw) > deadZone) target = Math.round(raw / colWidth);
      if (target !== pendingOffsetRef.current) {
        pendingOffsetRef.current = target;
        setColumnOffset(target);
        if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; }
        if (target !== 0) {
          collapseTimerRef.current = setTimeout(() => {
            setSourceCollapsed(true);
            collapseTimerRef.current = null;
          }, 500);
        } else {
          setSourceCollapsed(false);
        }
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      startXRef.current = null;
    };
  }, [activeId, activeRectWidth]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverId((over?.id as string) || null);
  }, []);

  const handleCrossSectionMove = useCallback((a: Task, o: Task) => {
    setTasks((prev) => {
      const fromOthers = prev.filter((t) => t.list === a.list && t.section === a.section && t.id !== a.id).map((t, i) => ({ ...t, order: i }));
      const toOthers = prev.filter((t) => t.list === o.list && t.section === o.section);
      const overIndex = toOthers.findIndex((t) => t.id === o.id);
      const moved = { ...a, list: o.list, section: o.section };
      const reorderedTo = [...toOthers.slice(0, overIndex), moved, ...toOthers.slice(overIndex)].map((t, i) => ({ ...t, order: i }));
      const untouched = prev.filter((t) => !(t.list === a.list && t.section === a.section) && !(t.list === o.list && t.section === o.section));
      return [...untouched, ...fromOthers, ...reorderedTo];
    });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setOverId(null);
    const clearOverlay = () => { setActiveId(null); setActiveType(null); setActiveProject(null); setActiveProjTask(null); };
    const resetDragRefs = () => {
      setColumnOffset(0); pendingOffsetRef.current = 0;
      if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; }
      if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; }
      setSourceCollapsed(false);
    };
    if (active.data.current?.type === 'projTask') {
      const srcTask = active.data.current.task as Task;
      const overData = over?.data.current;
      let targetList: ListId = srcTask.list;
      let targetProjectId: string | undefined = srcTask.projectId;
      if (overData?.type === 'project') {
        targetProjectId = (overData.project as Project).id;
        if (overData.listId) targetList = overData.listId as ListId;
      } else if (overData?.type === 'projTask') {
        const overTask = overData.task as Task;
        targetProjectId = overTask.projectId;
        targetList = overTask.list;
      }
      if (targetList !== srcTask.list || targetProjectId !== srcTask.projectId) {
        setTasks((prev) => {
          // Remove source first to avoid double-counting when source/target bucket overlap
          const without = prev.filter((t) => t.id !== srcTask.id);
          const moved: Task = { ...srcTask, list: targetList, projectId: targetProjectId };
          // Build target bucket, insert moved at correct position
          const targetBucket = without.filter((t) => t.list === targetList && t.section === srcTask.section);
          let insertIdx = targetBucket.length;
          if (overData?.type === 'projTask') {
            const overTask = overData.task as Task;
            const idx = targetBucket.findIndex((t) => t.id === overTask.id);
            if (idx >= 0) insertIdx = idx;
          }
          targetBucket.splice(insertIdx, 0, moved);
          const reorderedTarget = targetBucket.map((t, i) => ({ ...t, order: i }));
          // Source bucket (after source removal) — may equal target if same list
          const sameBucket = srcTask.list === targetList;
          const sourceBucket = sameBucket ? [] : without.filter((t) => t.list === srcTask.list && t.section === srcTask.section).map((t, i) => ({ ...t, order: i }));
          const untouched = without.filter((t) =>
            !(t.list === targetList && t.section === srcTask.section) &&
            (sameBucket || !(t.list === srcTask.list && t.section === srcTask.section))
          );
          return [...untouched, ...sourceBucket, ...reorderedTarget];
        });
      }
      resetDragRefs();
      clearOverlay(); return;
    }
    if (active.data.current?.type === 'project' && over) {
      const srcProject = active.data.current.project as Project;
      const overData = over.data.current;
      let targetClientId: string | undefined = srcProject.clientId;
      if (overData?.type === 'project') targetClientId = (overData.project as Project).clientId;
      else if (overData?.type === 'clientHeader') targetClientId = (overData.clientId as string);
      const overProjectId = overData?.type === 'project' ? (overData.project as Project).id : null;
      setProjects((prev) => {
        let next = prev.map((p) => (p.id === srcProject.id ? { ...p, clientId: targetClientId } : p));
        if (overProjectId && overProjectId !== srcProject.id) {
          const oldI = next.findIndex((p) => p.id === srcProject.id);
          const newI = next.findIndex((p) => p.id === overProjectId);
          if (oldI >= 0 && newI >= 0) next = arrayMove(next, oldI, newI);
        }
        return next;
      });
      resetDragRefs();
      clearOverlay(); return;
    }
    if (!over || active.id === over.id) { setActiveId(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false); return; }
    const overIdStr = String(over.id);
    if (overIdStr.startsWith('cal:')) {
      const [, targetDate, targetListRaw] = overIdStr.split(':');
      const droppedList = targetListRaw as ListId;
      const srcTask = tasks.find((t) => t.id === active.id);
      if (srcTask) {
        // Default: snap back to source category. Hold Ctrl/Cmd to allow category change.
        const targetList: ListId = ctrlDownRef.current ? droppedList : srcTask.list;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const targetDateObj = new Date(targetDate + 'T00:00:00');
        const targetSection: SectionId = targetDateObj.getTime() <= today.getTime() ? 'today' : 'next';
        const sameBucket = srcTask.list === targetList && srcTask.section === targetSection;
        setTasks((prev) => {
          // Remove source first so it can't be double-counted.
          const without = prev.filter((t) => t.id !== srcTask.id);
          const moved: Task = { ...srcTask, list: targetList, section: targetSection, deadline: targetDate };
          if (sameBucket) {
            // Append moved to end of the combined bucket, reorder, leave other buckets untouched.
            const bucket = without.filter((t) => t.list === targetList && t.section === targetSection);
            const reordered = [...bucket, moved].map((t, i) => ({ ...t, order: i }));
            const untouched = without.filter((t) => !(t.list === targetList && t.section === targetSection));
            return [...untouched, ...reordered];
          }
          const fromOthers = without.filter((t) => t.list === srcTask.list && t.section === srcTask.section).map((t, i) => ({ ...t, order: i }));
          const toBucket = without.filter((t) => t.list === targetList && t.section === targetSection);
          const reorderedTo = [...toBucket, moved].map((t, i) => ({ ...t, order: i }));
          const untouched = without.filter((t) => !(t.list === srcTask.list && t.section === srcTask.section) && !(t.list === targetList && t.section === targetSection));
          return [...untouched, ...fromOthers, ...reorderedTo];
        });
      }
      resetDragRefs();
      clearOverlay(); return;
    }
    if (overIdStr.startsWith('section:')) {
      const [, targetList, targetSection] = overIdStr.split(':') as ['section', ListId, SectionId];
      const srcTask = tasks.find((t) => t.id === active.id);
      if (srcTask && (srcTask.list !== targetList || srcTask.section !== targetSection)) {
        setTasks((prev) => {
          const fromOthers = prev.filter((t) => t.list === srcTask.list && t.section === srcTask.section && t.id !== srcTask.id).map((t, i) => ({ ...t, order: i }));
          const toBucket = prev.filter((t) => t.list === targetList && t.section === targetSection && t.id !== srcTask.id);
          const moved: Task = { ...srcTask, list: targetList, section: targetSection };
          const reorderedTo = [...toBucket, moved].map((t, i) => ({ ...t, order: i }));
          const untouched = prev.filter((t) => !(t.list === srcTask.list && t.section === srcTask.section) && !(t.list === targetList && t.section === targetSection));
          return [...untouched, ...fromOthers, ...reorderedTo];
        });
      }
      resetDragRefs();
      clearOverlay(); return;
    }
    const a = tasks.find((t) => t.id === active.id);
    const o = tasks.find((t) => t.id === over.id);
    if (!a || !o) { setActiveId(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false); return; }
    if (a.list === o.list && a.section === o.section) {
      setTasks((prev) => {
        const list = prev.filter((t) => t.list === a.list && t.section === a.section).sort((x, y) => x.order - y.order);
        const oldI = list.findIndex((t) => t.id === a.id);
        const newI = list.findIndex((t) => t.id === o.id);
        if (oldI === newI) return prev;
        const reordered = arrayMove(list, oldI, newI).map((t, i) => ({ ...t, order: i }));
        return [...prev.filter((t) => !(t.list === a.list && t.section === a.section)), ...reordered];
      });
    } else {
      handleCrossSectionMove(a, o);
    }
    setActiveId(null); setActiveType(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false);
  }, [tasks]);

  const [currentUserShort, setCurrentUserShortState] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('todo-app-user-short') || '';
  });
  const setCurrentUserShort = useCallback((s: string) => {
    setCurrentUserShortState(s);
    try { window.localStorage.setItem('todo-app-user-short', s); } catch {}
  }, []);
  // Default to first person if unset
  useEffect(() => {
    if (!currentUserShort && people.length > 0) setCurrentUserShort(people[0].short);
  }, [currentUserShort, people, setCurrentUserShort]);

  // One-time migration: Russell → Benno
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    const russell = people.find((p) => p.name === 'Russell');
    if (russell) {
      migratedRef.current = true;
      setPeople((prev) => prev.map((p) => (p.id === russell.id ? { ...p, name: 'Benno', short: 'B' } : p)));
      if (russell.short && russell.short !== 'B') {
        const old = russell.short;
        setTasks((prev) => prev.map((t) => ({ ...t, assignees: t.assignees.map((a) => (a === old ? 'B' : a)) })));
      }
      if (currentUserShort === russell.short) setCurrentUserShort('B');
    }
  }, [people, setPeople, setTasks, currentUserShort, setCurrentUserShort]);

  const tasksByKey = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const t of tasks) {
      const k = `${t.list}:${t.section}`;
      (m[k] ||= []).push(t);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.order - b.order);
    // Dashboard = aggregated view of work+projects+admin filtered to current user
    const dashSections: SectionId[] = ['inbox', 'today', 'next'];
    for (const s of dashSections) {
      const agg: Task[] = [];
      for (const l of ['work', 'projects', 'admin'] as ListId[]) {
        for (const t of (m[`${l}:${s}`] || [])) {
          if (t.assignees.includes(currentUserShort)) agg.push(t);
        }
      }
      m[`dashboard:${s}`] = agg;
    }
    return m;
  }, [tasks]);

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null;
  const overTask = overId ? tasks.find((t) => t.id === overId) : null;

  const getAnimationProps = useCallback((task: Task, index: number, list: Task[]) => {
    if (!activeTask || !overTask || activeTask.id === task.id) return { displacementOffset: 0, insertionGap: 0 };
    const sameBucket = (x: Task, y: Task) => x.list === y.list && x.section === y.section;
    const inActiveBucket = sameBucket(activeTask, task);
    const inOverBucket = sameBucket(overTask, task);
    if (!inActiveBucket && !inOverBucket) return { displacementOffset: 0, insertionGap: 0 };

    if (!sameBucket(activeTask, task) && sameBucket(overTask, task)) {
      const overIndex = list.findIndex((t) => t.id === overTask.id);
      if (index === overIndex) return { displacementOffset: 0, insertionGap: 41 };
      return { displacementOffset: 0, insertionGap: 0 };
    }
    if (inActiveBucket && inOverBucket) {
      const aI = list.findIndex((t) => t.id === activeTask.id);
      const oI = list.findIndex((t) => t.id === overTask.id);
      if (aI < oI && index > aI && index <= oI) return { displacementOffset: -41, insertionGap: 0 };
      if (aI > oI && index >= oI && index < aI) return { displacementOffset: 41, insertionGap: 0 };
    }
    return { displacementOffset: 0, insertionGap: 0 };
  }, [activeTask, overTask]);

  const renderBucket = (list: Task[]) => (
    <SortableContext items={list.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      <AnimatePresence>
        {list.map((task, index) => {
          const { displacementOffset, insertionGap } = getAnimationProps(task, index, list);
          return (
            <SortableTaskItem key={task.id} task={task} onToggle={() => toggleTask(task.id)} onRename={(title) => renameTask(task.id, title)} onDelete={() => deleteTask(task.id)} onEdit={() => setEditingTask(task)} displacementOffset={displacementOffset} insertionGap={insertionGap} isAnyDragging={!!activeTask} collapsed={sourceCollapsed && task.id === activeId} projects={projects} clients={clients} />
          );
        })}
      </AnimatePresence>
    </SortableContext>
  );

  const renderReadonlyBucket = (list: Task[]) => (
    <>
      {list.map((task) => {
        const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
        const client = project?.clientId ? clients.find((c) => c.id === project.clientId) : undefined;
        const isScheduled = task.type === 'scheduled';
        const titleColor = isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#5e5e5e]' : 'text-white';
        const metaColor = isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
        return (
          <div key={`dash-${task.id}`} onDoubleClick={() => setEditingTask(task)} className={`h-[37px] box-border flex flex-row gap-2 items-center px-[31px] w-full group ${task.completed ? 'bg-[#2d2d2d]' : 'hover:bg-white/[0.03]'}`}>
            {!isScheduled && <TaskCheckbox completed={task.completed} onToggle={() => toggleTask(task.id)} />}
            <div className="flex flex-row items-center gap-[4px]">
              {project && <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap text-[#656464]">{project.name}</p>}
              <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${titleColor}`}>{task.title}</span>
              {client && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${metaColor}`}>{client.short}</p>}
            </div>
            {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} />)}
            {task.deadline && (
              <>
                {!isScheduled && <DeadlineArrow />}
                <p className={`font-['NB_International:Regular',sans-serif] text-[14.333px] whitespace-nowrap ${isScheduled ? 'text-[#8465ff]' : 'text-white'}`}>{formatDeadline(task.deadline)}</p>
              </>
            )}
            <button
              type="button"
              onClick={() => deleteTask(task.id)}
              className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
              aria-label="Delete task"
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </>
  );

  const renderColumn = (listId: ListId) => {
    const bucket = listId === 'dashboard' ? renderReadonlyBucket : renderBucket;
    const wrap = (section: SectionId, node: React.ReactNode) =>
      listId === 'dashboard' ? node : <SectionDroppable id={`section:${listId}:${section}`}>{node}</SectionDroppable>;
    return (
      <div key={listId} className="flex-1 min-w-[340px] max-w-[440px]">
        <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-white text-[14.333px] px-[35px] mb-[50px]">
          {LIST_TITLES[listId]}
        </p>
        {wrap('inbox', bucket(tasksByKey[`${listId}:inbox`] || []))}
        <Spacer />
        <SectionHeader title="Today" />
        {wrap('today', bucket(tasksByKey[`${listId}:today`] || []))}
        <Spacer />
        <SectionHeader title="Next" />
        {wrap('next', bucket(tasksByKey[`${listId}:next`] || []))}
      </div>
    );
  };

  const calendarCollision = useCallback((args: Parameters<typeof pointerWithin>[0]) => {
    const collisions = pointerWithin(args);
    if (mode !== 'calendar') return collisions;
    const activeCellId = args.active.data.current?.calendarCellId as string | undefined;
    const activeTask = args.active.data.current?.task as Task | undefined;
    if (!activeCellId || !activeTask) return collisions;
    const activeList = activeTask.list;
    const allowListChange = ctrlDownRef.current;

    // Resolve the target day from any collision — whether on a cal cell or a task card in a different cell.
    const dayFromCollision = (c: { id: string | number }): string | null => {
      const id = String(c.id);
      if (id.startsWith('cal:')) return id.split(':')[1] || null;
      const container = args.droppableContainers.find((d) => d.id === c.id);
      const otherCell = container?.data?.current?.calendarCellId as string | undefined;
      if (otherCell) return otherCell.split(':')[1] || null;
      return null;
    };

    // Track per-cell collisions (to preserve intra-cell sortable reordering).
    const cellHits: typeof collisions = [];
    let columnHit: { id: string; date: string } | null = null;
    const seen = new Set<string>();
    for (const c of collisions) {
      const id = String(c.id);
      if (id.startsWith('col:')) {
        if (!columnHit) columnHit = { id, date: id.split(':')[1] };
        continue;
      }
      if (id.startsWith('cal:')) {
        const [, date, list] = id.split(':');
        if (allowListChange || list === activeList) {
          if (!seen.has(id)) { cellHits.push(c); seen.add(id); }
        } else {
          const redirectId = `cal:${date}:${activeList}`;
          if (!seen.has(redirectId)) { cellHits.push({ ...c, id: redirectId }); seen.add(redirectId); }
        }
        continue;
      }
      // Task-card collision.
      const container = args.droppableContainers.find((d) => d.id === c.id);
      const otherCell = container?.data?.current?.calendarCellId as string | undefined;
      if (otherCell && otherCell === activeCellId) {
        if (!seen.has(id)) { cellHits.push(c); seen.add(id); }
        continue;
      }
      const day = otherCell ? otherCell.split(':')[1] : dayFromCollision(c);
      if (day) {
        const redirectId = `cal:${day}:${activeList}`;
        if (!seen.has(redirectId)) { cellHits.push({ ...c, id: redirectId }); seen.add(redirectId); }
      }
    }
    if (cellHits.length > 0) return cellHits;
    // No direct cell/card hit — fall back to a column hit, redirecting to source-list cell for that day.
    if (columnHit) {
      return [{ id: `cal:${columnHit.date}:${activeList}`, data: { droppableContainer: null as any, value: 1 } } as unknown as (typeof collisions)[number]];
    }
    return [];
  }, [mode]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={calendarCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      measuring={measuringConfig}
      modifiers={activeType === 'task' || activeType === 'projTask' ? [restrictToVerticalAxis] : []}
    >
      <div className="relative min-h-screen bg-[#282828] overflow-x-auto">
        {mode === 'dashboard' && (
          <div className="pt-[106px] pb-[140px] flex gap-0 min-w-[1760px]">
            {LISTS.map(renderColumn)}
          </div>
        )}
        {mode === 'projectView' && (
          <ProjectViewMode
            projects={projects}
            clients={clients}
            tasks={tasks}
            newId={newId}
            isAnyDragging={!!activeId}
            isDraggingProjTask={activeType === 'projTask'}
            activeProjTaskId={activeProjTask?.id ?? null}
            sourceCollapsed={sourceCollapsed}
            onToggleTask={toggleTask}
            onRenameTask={renameTask}
            onAddTaskToProject={addTaskToProject}
            onAddTaskInList={(l) => addBlankProject(undefined, l)}
            onAddClient={addBlankClient}
            onRenameClient={renameClient}
            onRenameClientShort={renameClientShort}
            onDeleteClient={deleteClient}
            onAddProject={addBlankProject}
            onRenameProject={renameProject}
            onDeleteProject={deleteProject}
          />
        )}
        {mode === 'calendar' && (
          <WeekCalendarMode
            tasks={tasks}
            projects={projects}
            clients={clients}
            onToggleTask={toggleTask}
            onRenameTask={renameTask}
            onDeleteTask={deleteTask}
            onEditTask={(t) => setEditingTask(t)}
            isAnyDragging={!!activeId}
          />
        )}
        {mode === 'settings' && (
          <SettingsMode
            people={people}
            newId={newId}
            onAddPerson={addPerson}
            onRenamePerson={renamePerson}
            onRenamePersonShort={renamePersonShort}
            onDeletePerson={deletePerson}
            currentUserShort={currentUserShort}
            onSetCurrentUser={setCurrentUserShort}
          />
        )}

        <BottomBar mode={mode} onSetMode={setMode} onAdd={() => setShowAdd(true)} />

        <AnimatePresence>
          {showAdd && (
            <AddModal
              onClose={() => { setShowAdd(false); setPrefillList(null); }}
              onAddTask={addTask}
              onAddProject={addProject}
              onAddClient={addClient}
              projects={projects}
              clients={clients}
              people={people}
              defaultList={prefillList ?? undefined}
            />
          )}
          {editingTask && (
            <AddModal
              key={editingTask.id}
              onClose={() => setEditingTask(null)}
              onAddTask={addTask}
              onUpdateTask={updateTask}
              onAddProject={addProject}
              onAddClient={addClient}
              projects={projects}
              clients={clients}
              people={people}
              editingTask={editingTask}
            />
          )}
        </AnimatePresence>

        <DragOverlay dropAnimation={null} style={{ cursor: 'grabbing' }}>
          {activeTask && activeType === 'task' ? (
            <motion.div
              initial={{ scale: 1, x: 0 }}
              animate={{
                scale: 1.02,
                x: columnOffset * (activeRectWidth || 440),
                boxShadow: "0 7.5px 15px -2.5px rgba(0, 0, 0, 0.7), 0 5px 6.25px -1.25px rgba(0, 0, 0, 0.5)",
              }}
              transition={{
                scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 },
                x: { type: "spring", stiffness: 320, damping: 34, mass: 0.7 },
              }}
              className="bg-[#333333] border border-[#444444]"
              style={{ width: activeRectWidth }}
            >
              <SortableTaskItem task={activeTask} onToggle={() => {}} isDragOverlay projects={projects} clients={clients} />
            </motion.div>
          ) : null}
          {activeProject ? (
            <motion.div
              initial={{ scale: 1 }}
              animate={{ scale: 1.02, boxShadow: "0 7.5px 15px -2.5px rgba(0, 0, 0, 0.7), 0 5px 6.25px -1.25px rgba(0, 0, 0, 0.5)" }}
              transition={{ scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 } }}
              className="bg-[#333333] border border-[#444444] h-[37px] box-border flex flex-row gap-2 items-center px-[31px]"
              style={{ width: activeRectWidth }}
            >
              <Folder size={12} className="text-[#656464]" />
              <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] text-white whitespace-nowrap">{activeProject.name}</span>
            </motion.div>
          ) : null}
          {activeProjTask ? (
            <motion.div
              initial={{ scale: 1, x: 0 }}
              animate={{
                scale: 1.02,
                x: columnOffset * (activeRectWidth || 440),
                boxShadow: "0 7.5px 15px -2.5px rgba(0, 0, 0, 0.7), 0 5px 6.25px -1.25px rgba(0, 0, 0, 0.5)",
              }}
              transition={{
                scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 },
                x: { type: "spring", stiffness: 320, damping: 34, mass: 0.7 },
              }}
              className="bg-[#333333] border border-[#444444] h-[37px] box-border flex flex-row gap-2 items-center pl-[43px] pr-[31px]"
              style={{ width: activeRectWidth }}
            >
              <LIndent />
              <TaskCheckbox completed={activeProjTask.completed} onToggle={() => {}} />
              <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${activeProjTask.completed ? 'text-[#5e5e5e] line-through' : 'text-white'}`}>{activeProjTask.title}</span>
            </motion.div>
          ) : null}
        </DragOverlay>
      </div>
    </DndContext>
  );
}
