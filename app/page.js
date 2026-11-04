import Predictor from "@/components/Predictor";
import ErrorBoundary from "@/components/ErrorBoundary";
export default function Home() { return <ErrorBoundary><Predictor /></ErrorBoundary>; }
export const metadata = {
  title: "Joetito's School of Data",
  description: "NBA and NFL predictions from ESPN and Odds API data",
};
