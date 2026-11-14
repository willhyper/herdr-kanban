import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, spaces, theme } from "herdr";

export default class KanbanPane extends View {
  render() {
    const pane = panes().find(item => item.pane === props()?.pane);
    if (!pane) return div();
    const tab = spaces().flatMap(space => space.tabs ?? []).find(item => item.id === pane.tab);
    const title = tab?.named ? tab.name : pane.program?.name || pane.title || "Terminal";
    const t = theme();
    const program = pane.program;
    const icon = program?.icon && (program.tint
      ? svg(program.icon).size(14).text_color(t.dim)
      : image(program.icon).w(14).h(14));
    return h_flex().size_full().items_center().gap(8).px(10).bg(t.background)
      .border_b(1).border_color(t.border)
      .on_click(() => run("pane.focus", { pane: pane.pane }))
      .when(Boolean(icon), el => el.child(icon))
      .child(div().flex_none().truncate().max_w(360).font_medium().text_color(t.foreground).child(title))
      .child(div().flex_1().truncate().text_color(t.dim).child(pane.cwd || ""));
  }
}
