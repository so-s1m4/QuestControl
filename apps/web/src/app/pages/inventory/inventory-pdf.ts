import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";

export type InventoryPdfMovement = {
  id: string;
  delta: number | string;
  quantity_after: number | string;
  reason: string;
  operation_count: number;
  created_at: string;
  last_event_at: string;
  created_by_name: string;
};

export type InventoryPdfItem = {
  id: string;
  location_name: string;
  name: string;
  category: string;
  unit: string;
  quantity: number | string;
  minimum_quantity: number | string;
  initial_quantity: number | string;
  notes: string | null;
  low_stock: boolean;
  created_at: string;
  movements: InventoryPdfMovement[];
};

export type InventoryPdfReport = {
  generatedAt: string;
  scope: string;
  items: InventoryPdfItem[];
};

const numeric = (value: number | string) => Number(value) || 0;
const amount = (value: number | string) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(numeric(value));
const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(value));

const movementDate = (movement: InventoryPdfMovement) => {
  const first = dateTime(movement.created_at);
  const last = dateTime(movement.last_event_at);
  return movement.operation_count > 1 && first !== last ? `${first} - ${last}` : last;
};

const signedAmount = (value: number | string) => `${numeric(value) > 0 ? "+" : "-"}${amount(Math.abs(numeric(value)))}`;

export function buildInventoryPdf(report: InventoryPdfReport): TDocumentDefinitions {
  const summaryLayout = {
    fillColor: (rowIndex: number) => rowIndex === 0 ? "#eef0ff" : "#f8f9fc",
    hLineColor: () => "#dfe3ea",
    vLineColor: () => "#dfe3ea",
    paddingLeft: () => 8,
    paddingRight: () => 8,
    paddingTop: () => 7,
    paddingBottom: () => 7,
  };
  const movementLayout = {
    fillColor: (rowIndex: number) => rowIndex === 0 ? "#101828" : (rowIndex % 2 === 0 ? "#f8f9fc" : null),
    hLineColor: () => "#e4e7ec",
    vLineColor: () => "#e4e7ec",
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 5,
    paddingBottom: () => 5,
  };
  const content: Content[] = [
    { text: "QUESTCONTROL", style: "brand" },
    { text: "Отчёт по инвентарю", style: "title" },
    { text: `${report.scope} | Сформирован ${dateTime(report.generatedAt)}`, style: "subtitle", margin: [0, 0, 0, 20] },
  ];

  if (!report.items.length) {
    content.push({ text: "В выбранном клубе нет активных позиций инвентаря.", style: "empty" });
  }

  report.items.forEach((item, index) => {
    const incoming = item.movements.reduce((total, movement) => total + Math.max(0, numeric(movement.delta)), 0);
    const outgoing = item.movements.reduce((total, movement) => total + Math.max(0, -numeric(movement.delta)), 0);
    const movementRows: Content[][] = [
      [
        dateTime(item.created_at),
        "Начальный остаток",
        `+${amount(item.initial_quantity)} ${item.unit}`,
        `${amount(item.initial_quantity)} ${item.unit}`,
        "Позиция добавлена",
        "-",
      ],
      ...item.movements.map((movement): Content[] => [
        movementDate(movement),
        numeric(movement.delta) > 0 ? "Приход" : "Списание",
        `${signedAmount(movement.delta)} ${item.unit}`,
        `${amount(movement.quantity_after)} ${item.unit}`,
        `${movement.reason}${movement.operation_count > 1 ? ` (${movement.operation_count} операции)` : ""}`,
        movement.created_by_name,
      ]),
    ];

    content.push(
      {
        text: `${index + 1}. ${item.name}`,
        style: "itemTitle",
        pageBreak: index === 0 ? undefined : "before",
      },
      {
        columns: [
          { text: `${item.location_name} | ${item.category}`, style: "itemMeta" },
          { text: item.low_stock ? "НУЖНО ПОПОЛНИТЬ" : "В НАЛИЧИИ", style: item.low_stock ? "statusLow" : "statusOk", alignment: "right" },
        ],
        margin: [0, 0, 0, 10],
      },
      ...(item.notes ? [{ text: `Комментарий: ${item.notes}`, style: "note", margin: [0, 0, 0, 10] } as Content] : []),
      {
        table: {
          widths: ["*", "*", "*", "*", "*"],
          body: [
            ["Начальный остаток", "Всего приход", "Всего списано", "Сейчас", "Минимум"],
            [
              `${amount(item.initial_quantity)} ${item.unit}`,
              `+${amount(incoming)} ${item.unit}`,
              `-${amount(outgoing)} ${item.unit}`,
              `${amount(item.quantity)} ${item.unit}`,
              `${amount(item.minimum_quantity)} ${item.unit}`,
            ],
          ],
        },
        layout: summaryLayout,
        margin: [0, 0, 0, 16],
      },
      { text: "История движения", style: "sectionTitle" },
      {
        table: {
          headerRows: 1,
          widths: [76, 60, 62, 62, "*", 75],
          body: [
            ["Дата", "Операция", "Количество", "Остаток", "Причина", "Сотрудник"].map(text => ({ text, style: "tableHeader" })),
            ...movementRows,
          ],
        },
        layout: movementLayout,
      },
    );
  });

  return {
    pageSize: "A4",
    pageOrientation: "landscape",
    pageMargins: [32, 34, 32, 34],
    defaultStyle: { font: "Roboto", fontSize: 8, color: "#344054" },
    content,
    styles: {
      brand: { fontSize: 9, bold: true, color: "#4f46e5", characterSpacing: 2.2, margin: [0, 0, 0, 7] },
      title: { fontSize: 25, bold: true, color: "#101828", margin: [0, 0, 0, 5] },
      subtitle: { fontSize: 9, color: "#667085" },
      itemTitle: { fontSize: 17, bold: true, color: "#101828", margin: [0, 0, 0, 5] },
      itemMeta: { fontSize: 9, color: "#667085" },
      statusLow: { fontSize: 8, bold: true, color: "#b54708" },
      statusOk: { fontSize: 8, bold: true, color: "#087443" },
      note: { fontSize: 8, italics: true, color: "#667085" },
      sectionTitle: { fontSize: 10, bold: true, color: "#101828", margin: [0, 0, 0, 7] },
      tableHeader: { fontSize: 8, bold: true, color: "#ffffff" },
      empty: { fontSize: 11, color: "#667085", margin: [0, 16, 0, 0] },
    },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: "QuestControl | Инвентарь", color: "#98a2b3", fontSize: 7 },
        { text: `${currentPage} / ${pageCount}`, alignment: "right", color: "#98a2b3", fontSize: 7 },
      ],
      margin: [32, 8, 32, 0],
    }),
  };
}
