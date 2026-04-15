import { Routes, Route, Link } from 'react-router-dom';
import MerchantCheckout from './pages/MerchantCheckout';
import CustomerPayment from './pages/CustomerPayment';

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<MerchantCheckout />} />
        <Route path="/pay/:rlid" element={<CustomerPayment />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>Not found</h1>
              <Link to="/">Back to checkout</Link>
            </div>
          }
        />
      </Routes>
    </div>
  );
}
