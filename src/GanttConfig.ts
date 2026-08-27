import type { BryntumGanttProps } from '@bryntum/gantt-react';

const ganttProps : BryntumGanttProps = {
    startDate  : new Date(2026, 0, 1),
    endDate    : new Date(2026, 2, 1),
    viewPreset : 'dayAndMonth',
    columns    : [{ type : 'name', field : 'name', width : 450 }],

    barMargin  : 10,
    // Tall rows (with the font-size bump in App.css) give each label more
    // pixels in the 704x704 frame sent to Flux — small text is what the
    // model garbles first
    rowHeight  : 56,

    project : {
        transport : {
            load : {
                url : 'data.json'
            }
        },
        autoLoad           : true,
        // Automatically introduces a `startnoearlier` constraint for tasks that (a) have no predecessors, (b) do not use
        // constraints and (c) aren't `manuallyScheduled`
        autoSetConstraints : true
    }
};

export { ganttProps };
