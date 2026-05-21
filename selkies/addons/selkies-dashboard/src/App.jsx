// src/App.jsx
import DashboardOverlay from './components/DashboardOverlay';

// App receives the dashboardRoot element created in main.jsx
function App({ dashboardRoot }) {
  return (
    <>
      <DashboardOverlay container={dashboardRoot} />
    </>
  );
}

export default App;
