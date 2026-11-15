export interface ScuExam {
  readonly courseName: string;
  readonly week: string;
  readonly date: string;
  readonly weekday: string;
  readonly timeRange: string;
  readonly location: string;
  readonly seatNumber: string;
  readonly ticketNumber: string;
  readonly tip: string;
}

export interface ScuNotice {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly url: string;
}

export interface ScuNoticeDetail extends ScuNotice {
  readonly content: string;
}

export interface ScuCardTransaction {
  readonly toname: string;
  readonly jdate: number;
  readonly xfje: number;
  readonly syje: number;
  readonly type: string;
  readonly time: string;
  readonly day: string;
}

export interface ScuCardHistory {
  readonly transactions: readonly ScuCardTransaction[];
  readonly byDay: Readonly<Record<string, number>>;
  readonly totalCost: number;
  readonly txnCount: number;
  readonly balance: number | null;
  readonly balanceAsOf: string;
}

export interface AcademicCalendarEvent {
  readonly label: string;
  readonly tag: string;
  readonly date: string;
  readonly endDate: string | null;
}

export interface AcademicCalendarSemester {
  readonly name: string;
  readonly startDate: string;
  readonly totalWeeks: number;
  readonly events: readonly AcademicCalendarEvent[];
}

export interface AcademicCalendar {
  readonly semesters: readonly AcademicCalendarSemester[];
}
