// Blueprint's date range picker, with its dependencies (react-day-picker, date-fns: ~130kB),
// is only needed in the lists of commits: AppNavbar loads it on demand.
import { DateRangeInput as BlueprintDateRangeInput } from "@blueprintjs/datetime";
import enUS from "date-fns/locale/en-US";

import "@blueprintjs/datetime/lib/css/blueprint-datetime.css";

const DateRangeInput = props => <BlueprintDateRangeInput locale={enUS} {...props}/>;
export default DateRangeInput;
