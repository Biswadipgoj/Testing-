'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Customer, Retailer, EMISchedule, DueBreakdown } from '@/lib/types';
import NavBar from '@/components/NavBar';
import SearchInput from '@/components/SearchInput';
import CustomerDetailPanel from '@/components/CustomerDetailPanel';
import CustomerFormModal from '@/components/CustomerFormModal';
import EMIScheduleTable from '@/components/EMIScheduleTable';
import DueBreakdownPanel from '@/components/DueBreakdownPanel';
import PaymentModal from '@/components/PaymentModal';
import toast from 'react-hot-toast';
import { addDays, subMonths, format } from 'date-fns';

type Tab = 'search' | 'retailers' | 'reports' | 'broadcast';

interface FilteredEMI {
  id: string;
  emi_no: number;
  due_date: string;
  amount: number;
  status: string;
  fine_amount: number;
  customer_name: string;
  imei: string;
  mobile: string;
  retailer_name: string;
  customer_id: string;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

async function exportCSV(supabase: ReturnType<typeof createClient>, type: string) {
  toast('Generating report...', { icon: '📊' });
  let data: Record<string, any>[] = [];
  let filename = 'report.csv';

  if (type === 'customers') {
    const { data: rows } = await supabase
      .from('customers')
      .select('id,customer_name,father_name,mobile,imei,aadhaar,model_no,purchase_date,purchase_value,down_payment,emi_amount,emi_tenure,first_emi_charge_amount,first_emi_charge_paid_at,status,retailer:retailers(name)')
      .order('customer_name');
    data = (rows || []).map((r: any) => ({
      ...r,
      retailer_name: r.retailer?.name || '',
      retailer: undefined,
    }));
    filename = 'customers.csv';
  } else if (type === 'emi_schedule') {
    const { data: rows } = await supabase
      .from('emi_schedule')
      .select('emi_no,due_date,amount,status,paid_at,mode,fine_amount,fine_waived,customer:customers(customer_name,imei)')
      .order('due_date');
    data = (rows || []).map((r: any) => ({
      ...r,
      customer_name: r.customer?.customer_name || '',
      imei: r.customer?.imei || '',
      customer: undefined,
    }));
    filename = 'emi_schedule.csv';
  } else if (type === 'upcoming') {
    const in30 = addDays(new Date(), 30).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const { data: rows } = await supabase
      .from('emi_schedule')
      .select('emi_no,due_date,amount,status,customer:customers(customer_name,imei,mobile,retailer:retailers(name))')
      .eq('status', 'UNPAID')
      .lte('due_date', in30)
      .gte('due_date', today)
      .order('due_date');
    data = (rows || []).map((r: any) => ({
      emi_no: r.emi_no, 
      due_date: r.due_date, 
      amount: r.amount,
      customer_name: r.customer?.customer_name || '',
      imei: r.customer?.imei || '',
      mobile: r.customer?.mobile || '',
      retailer: r.customer?.retailer?.name || '',
    }));
    filename = 'upcoming_emis_30days.csv';
  } else if (type === 'fine_report') {
    const { data: rows } = await supabase
      .from('emi_schedule')
      .select('emi_no,due_date,amount,fine_amount,customer:customers(customer_name,imei,mobile)')
      .eq('status', 'UNPAID')
      .eq('fine_waived', false)
      .gt('fine_amount', 0);
    data = (rows || []).map((r: any) => ({
      emi_no: r.emi_no, 
      due_date: r.due_date, 
      emi_amount: r.amount, 
      fine_due: r.fine_amount, 
      customer_name: r.customer?.customer_name || '', 
      imei: r.customer?.imei || '', 
      mobile: r.customer?.mobile || '' 
    }));
    filename = 'fine_due_report.csv';
  } else if (type === 'retailer_report') {
    const { data: rows } = await supabase
      .from('payment_requests')
      .select('created_at,total_amount,fine_amount,first_emi_charge_amount,mode,status,retailer:retailers(name),customer:customers(customer_name,imei)')
      .eq('status', 'APPROVED')
      .order('created_at', { ascending: false });
    data = (rows || []).map((r: any) => ({
      date: r.created_at, total: r.total_amount, fine: r.fine_amount, first_charge: r.first_emi_charge_amount, mode: r.mode,
      retailer: r.retailer?.name || '',
      customer: r.customer?.customer_name || '',
      imei: r.customer?.imei || '',
    }));
    filename = 'retailer_collection_report.csv';
  }

  if (!data.length) { toast.error('No data to export'); return; }
  const headers = Object.keys(data[0]).filter(h => data[0][h] !== undefined);
  const csv = [
    headers.join(','),
    ...data.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(','))
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast.success(`Downloaded: ${filename}`);
}

export default function AdminDashboard() {
  const supabase = createClient();
  const [tab, setTab] = useState<Tab>('search');
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [searchResults, setSearchResults] = useState<Customer[] | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerEmis, setCustomerEmis] = useState<EMISchedule[]>([]);
  const [breakdown, setBreakdown] = useState<DueBreakdown | null>(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [completeRemark, setCompleteRemark] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteRemark, setDeleteRemark] = useState('');
  const [showRetailerForm, setShowRetailerForm] = useState(false);
  const [editingRetailer, setEditingRetailer] = useState<Retailer | null>(null);
  const [retailerForm, setRetailerForm] = useState({ name: '', username: '', password: '', retail_pin: '', mobile: '' });
  const [fineSettings, setFineSettings] = useState({ default_fine_amount: 450 });
  const [pendingCount, setPendingCount] = useState(0);

  const [broadcastRetailerId, setBroadcastRetailerId] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastExpiry, setBroadcastExpiry] = useState('');
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [broadcastHistory, setBroadcastHistory] = useState<any[]>([]);

  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [filteredEmis, setFilteredEmis] = useState<FilteredEMI[] | null>(null);
  const [filterLoading, setFilterLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const loadPendingCount = useCallback(async () => {
    const { count } = await supabase.from('payment_requests').select('*', { count: 'exact', head: true }).eq('status', 'PENDING');
    setPendingCount(count || 0);
  }, [supabase]);

  const loadRetailers = useCallback(async () => {
    const { data } = await supabase.from('retailers').select('*').order('name');
    setRetailers(data || []);
  }, [supabase]);

  const loadFineSettings = useCallback(async () => {
    const { data } = await supabase.from('fine_settings').select('*').eq('id', 1).single();
    if (data) setFineSettings(data);
  }, [supabase]);

  const loadBroadcasts = useCallback(async () => {
    const { data } = await supabase
      .from('broadcast_messages')
      .select('*, retailer:retailers(name)')
      .order('created_at', { ascending: false })
      .limit(20);
    setBroadcastHistory(data || []);
  }, [supabase]);

  useEffect(() => {
    loadRetailers();
    loadFineSettings();
    loadPendingCount();
    loadBroadcasts();
  }, [loadRetailers, loadFineSettings, loadPendingCount, loadBroadcasts]);

  const selectCustomerFn = useCallback(async (customer: Customer) => {
    setSelectedCustomer(customer);
    const { data: emis } = await supabase.from('emi_schedule').select('*').eq('customer_id', customer.id).order('emi_no');
    setCustomerEmis((emis as EMISchedule[]) || []);
    const { data: bd } = await supabase.rpc('get_due_breakdown', { p_customer_id: customer.id });
    setBreakdown(bd as DueBreakdown);
  }, [supabase]);

  const handleSearch = useCallback(async (query: string) => {
    if (!query || query.length < 3) {
      setSearchResults(null);
      setSelectedCustomer(null);
      return;
    }
    setSearchLoading(true);
    try {
      let qb = supabase.from('customers').select('*, retailer:retailers(*)');
      if (/^\d{15}$/.test(query)) qb = qb.eq('imei', query);
      else if (/^\d{12}$/.test(query)) qb = qb.eq('aadhaar', query);
      else qb = qb.ilike('customer_name', `%${query}%`);

      const { data, error } = await qb.order('customer_name').limit(20);
      if (error) { console.error('Search error:', error); return; }
      const results = (data as Customer[]) || [];
      setSearchResults(results);
      if (results.length === 1) await selectCustomerFn(results[0]);
      else setSelectedCustomer(null);
    } finally {
      setSearchLoading(false);
    }
  }, [supabase, selectCustomerFn]);

  async function refreshSelectedCustomer() {
    if (selectedCustomer) await selectCustomerFn(selectedCustomer);
  }

  async function handleMarkComplete() {
    if (!selectedCustomer || !completeRemark.trim()) { toast.error('Completion remark required'); return; }
    const { error } = await supabase.from('customers').update({
      status: 'COMPLETE',
      completion_remark: completeRemark,
      completion_date: new Date().toISOString().split('T')[0],
    }).eq('id', selectedCustomer.id);
    if (error) toast.error(error.message);
    else {
      toast.success('Marked as COMPLETE');
      setShowCompleteModal(false);
      setCompleteRemark('');
      await selectCustomerFn({ ...selectedCustomer, status: 'COMPLETE' });
    }
  }

  async function handleDeleteCustomer() {
    if (!selectedCustomer || !deleteRemark.trim()) { toast.error('Deletion reason required'); return; }
    const { error } = await supabase.from('customers').delete().eq('id', selectedCustomer.id);
    if (error) toast.error(error.message);
    else {
      toast.success('Customer deleted');
      setShowDeleteConfirm(false);
      setDeleteRemark('');
      setSelectedCustomer(null);
      setSearchResults(null);
    }
  }

  async function handleRetailerSubmit(e: React.FormEvent) {
    e.preventDefault();
    const method = editingRetailer ? 'PATCH' : 'POST';
    const body = editingRetailer
      ? { id: editingRetailer.id, name: retailerForm.name, ...(retailerForm.password && { password: retailerForm.password }), ...(retailerForm.retail_pin && { retail_pin: retailerForm.retail_pin }), mobile: retailerForm.mobile || null }
      : { name: retailerForm.name, username: retailerForm.username, password: retailerForm.password, retail_pin: retailerForm.retail_pin, mobile: retailerForm.mobile || null };

    const res = await fetch('/api/retailers', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok) { toast.success(editingRetailer ? 'Retailer updated' : 'Retailer created'); loadRetailers(); setShowRetailerForm(false); }
    else toast.error(data.error);
  }

  async function handleDeleteRetailer(id: string) {
    if (!confirm('Delete this retailer? This cannot be undone.')) return;
    const res = await fetch(`/api/retailers?id=${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { toast.success('Retailer deleted'); loadRetailers(); }
    else toast.error(data.error);
  }

  async function handleToggleRetailerActive(r: Retailer) {
    const res = await fetch('/api/retailers', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id, is_active: !r.is_active }),
    });
    if (res.ok) { toast.success(r.is_active ? 'Retailer deactivated' : 'Retailer activated'); loadRetailers(); }
  }

  async function updateFineSettings() {
    const { error } = await supabase.from('fine_settings').update({ default_fine_amount: fineSettings.default_fine_amount }).eq('id', 1);
    if (!error) toast.success('Fine settings updated');
    else toast.error(error.message);
  }

  async function loadFilter(filterKey: string, days?: number, months?: number) {
    setActiveFilter(filterKey);
    setFilteredEmis(null);
    setFilterLoading(true);

    try {
      let query = supabase
        .from('emi_schedule')
        .select(`
          id, emi_no, due_date, amount, status, fine_amount, fine_waived,
          customer:customers(id, customer_name, imei, mobile, retailer:retailers(name))
        `)
        .eq('status', 'UNPAID');

      const today = new Date();

      if (filterKey === 'fine_only') {
        query = query.gt('fine_amount', 0).eq('fine_waived', false);
      } else if (days) {
        const target = addDays(today, days).toISOString().split('T')[0];
        query = query.lte('due_date', target).gte('due_date', today.toISOString().split('T')[0]);
      } else if (months) {
        const cutoff = subMonths(today, months).toISOString().split('T')[0];
        query = query.lt('due_date', cutoff);
      }

      const { data, error } = await query.order('due_date').limit(100);
      if (error) { toast.error(error.message); return; }

      const mapped: FilteredEMI[] = (data || []).map((row: any) => ({
        id: row.id,
        emi_no: row.emi_no,
        due_date: row.due_date,
        amount: row.amount,
        status: row.status,
        fine_amount: row.fine_amount || 0,
        customer_name: row.customer?.customer_name || '',
        imei: row.customer?.imei || '',
        mobile: row.customer?.mobile || '',
        retailer_name: row.customer?.retailer?.name || '',
        customer_id: row.customer?.id || '',
      }));
      setFilteredEmis(mapped);
    } finally {
      setFilterLoading(false);
    }
  }

  function clearFilter() {
    setActiveFilter(null);
    setFilteredEmis(null);
  }

  const paidCount = customerEmis.filter((e) => e.status === 'APPROVED').length;

  return (
    <div className="min-h-screen page-bg">
      <NavBar role="admin" userName="TELEPOINT" pendingCount={pendingCount} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-1 mb-8 bg-surface-2 rounded-2xl p-1.5 border border-surface-4 w-fit">
          {[
            { key: 'search', label: '🔍 Customer Search' },
            { key: 'retailers', label: '🏪 Retailers' },
            { key: 'reports', label: '📊 Reports & Settings' },
            { key: 'broadcast', label: '📢 Broadcast' },
          ].map((t: any) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                tab === t.key ? 'bg-brand-500 text-ink shadow-lg shadow-brand-500/20' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'search' && (
          <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="font-display text-3xl font-bold text-ink">Customer Search</h1>
                <p className="text-ink-muted text-sm mt-1">Search all customers — RUNNING and COMPLETE</p>
              </div>
              <button onClick={() => { setEditingCustomer(null); setShowCustomerForm(true); }} className="btn-primary">
                + New Customer
              </button>
            </div>

            <SearchInput onSearch={handleSearch} loading={searchLoading} autoFocus />

            {searchResults === null && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-20 h-20 rounded-3xl bg-surface-2 border border-surface-4 flex items-center justify-center mb-5">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(232,184,0,0.4)" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                </div>
                <p className="text-ink-muted text-lg">Enter name, IMEI, or Aadhaar to search</p>
                <p className="text-ink-muted text-sm mt-1">Results appear as you type — no button needed</p>
              </div>
            )}

            {searchResults !== null && searchResults.length === 0 && (
              <div className="text-center py-16">
                <p className="text-ink-muted">No customers found. Try a different search term.</p>
              </div>
            )}

            {searchResults !== null && searchResults.length > 1 && !selectedCustomer && (
              <div className="card overflow-hidden animate-fade-in">
                <div className="px-5 py-3 border-b border-surface-4">
                  <span className="text-xs text-ink-muted uppercase tracking-widest">{searchResults.length} customers found — click a row to view</span>
                </div>
                <table className="data-table">
                  <thead>
                    <tr><th>Name</th><th>IMEI</th><th>Mobile</th><th>Retailer</th><th>Status</th><th>EMI/mo</th><th /></tr>
                  </thead>
                  <tbody>
                    {searchResults.map((c) => (
                      <tr key={c.id} onClick={() => selectCustomerFn(c)} className="cursor-pointer">
                        <td>
                          <p className="text-ink font-medium">{c.customer_name}</p>
                          {c.father_name && <p className="text-xs text-ink-muted">C/O {c.father_name}</p>}
                        </td>
                        <td><span className="font-num text-xs">{c.imei}</span></td>
                        <td><span className="font-num">{c.mobile}</span></td>
                        <td><span className="text-ink-muted">{(c.retailer as any)?.name || '—'}</span></td>
                        <td>
                          {c.status === 'RUNNING'
                            ? <span className="badge-running">Running</span>
                            : <span className="badge-complete">Complete</span>}
                        </td>
                        <td><span className="font-num text-brand-600">{fmt(c.emi_amount)}</span></td>
                        <td>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-muted">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selectedCustomer && (
              <div className="space-y-5 animate-slide-up">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {searchResults && searchResults.length > 1 && (
                    <button onClick={() => setSelectedCustomer(null)} className="btn-ghost flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                      Back to results
                    </button>
                  )}
                  <div className="flex flex-wrap gap-2 ml-auto">
                    <button onClick={() => { setEditingCustomer(selectedCustomer); setShowCustomerForm(true); }} className="btn-ghost">
                      ✏️ Edit
                    </button>
                    {selectedCustomer.status === 'RUNNING' && (
                      <button onClick={() => setShowCompleteModal(true)} className="btn-success">
                        ✓ Mark Complete
                      </button>
                    )}
                    <button onClick={() => setShowPaymentModal(true)} className="btn-primary">
                      💳 Record Payment
                    </button>
                    <button onClick={() => setShowDeleteConfirm(true)} className="btn-danger">
                      🗑 Delete
                    </button>
                  </div>
                </div>

                <CustomerDetailPanel customer={selectedCustomer} paidCount={paidCount} totalEmis={selectedCustomer.emi_tenure} isAdmin={true} />
                {breakdown && <DueBreakdownPanel breakdown={breakdown} />}
                <EMIScheduleTable
                  emis={customerEmis}
                  nextUnpaidNo={breakdown?.next_emi_no ?? undefined}
                  isAdmin={true}
                  onRefresh={refreshSelectedCustomer}
                  defaultFineAmount={fineSettings.default_fine_amount}
                />
              </div>
            )}
          </div>
        )}

        {tab === 'retailers' && (
          <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="font-display text-3xl font-bold text-ink">Retailer Management</h1>
                <p className="text-ink-muted text-sm mt-1">{retailers.length} retailers registered</p>
              </div>
              <button
                onClick={() => { setEditingRetailer(null); setRetailerForm({ name: '', username: '', password: '', retail_pin: '', mobile: '' }); setShowRetailerForm(true); }}
                className="btn-primary"
              >
                + Add Retailer
              </button>
            </div>

            <div className="card overflow-hidden">
              <table className="data-table">
                <thead>
                  <tr><th>Name</th><th>Username</th><th>Mobile</th><th>Status</th><th>Created</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {retailers.map((r) => (
                    <tr key={r.id}>
                      <td className="font-medium text-ink">{r.name}</td>
                      <td><span className="font-num text-ink-muted">@{r.username}</span></td>
                      <td><span className="font-num text-ink-muted">{r.mobile || '—'}</span></td>
                      <td>{r.is_active ? <span className="badge-running">Active</span> : <span className="badge-rejected">Inactive</span>}</td>
                      <td className="text-xs text-ink-muted">{format(new Date(r.created_at), 'd MMM yyyy')}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setEditingRetailer(r); setRetailerForm({ name: r.name, username: r.username, password: '', retail_pin: '', mobile: r.mobile || '' }); setShowRetailerForm(true); }}
                            className="px-3 py-1 text-xs border border-surface-4 hover:border-brand-300 hover:text-brand-600 rounded-lg transition-colors text-ink-muted"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleToggleRetailerActive(r)}
                            className={`px-3 py-1 text-xs border rounded-lg transition-colors ${
                              r.is_active ? 'border-danger-border hover:border-danger text-danger' : 'border-success-border hover:border-jade-500/40 text-success'
                            }`}
                          >
                            {r.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            onClick={() => handleDeleteRetailer(r.id)}
                            className="px-3 py-1 text-xs border border-danger-border hover:border-danger text-danger rounded-lg transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {retailers.length === 0 && (
                    <tr><td colSpan={6} className="text-center text-ink-muted py-10">No retailers yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'reports' && (
          <div className="space-y-6 animate-fade-in">
            <h1 className="font-display text-3xl font-bold text-ink">Reports & Settings</h1>

            <div className="card p-6">
              <p className="section-header">Fine Settings</p>
              <div className="flex items-end gap-4">
                <div className="flex-1 max-w-xs">
                  <label className="form-label">Default Late Fine Amount (₹)</label>
                  <input
                    type="number"
                    value={fineSettings.default_fine_amount}
                    onChange={(e) => setFineSettings((f) => ({ ...f, default_fine_amount: parseFloat(e.target.value) }))}
                    className="form-input"
                    min={0}
                  />
                </div>
                <button onClick={updateFineSettings} className="btn-primary">Save</button>
              </div>
            </div>

            <div className="card p-6">
              <p className="section-header">Export Reports (CSV)</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: 'All Customers', action: 'customers' },
                  { label: 'Full EMI Schedule', action: 'emi_schedule' },
                  { label: 'Retailer Collection', action: 'retailer_report' },
                  { label: 'Upcoming EMIs (30d)', action: 'upcoming' },
                  { label: 'Fine Due Report', action: 'fine_report' },
                ].map((item) => (
                  <button
                    key={item.action}
                    onClick={() => exportCSV(supabase, item.action)}
                    className="px-4 py-3 rounded-xl border border-surface-4 hover:border-brand-300 text-ink-muted hover:text-brand-600 text-sm font-medium transition-all text-left flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <p className="section-header mb-0">EMI Due Filters</p>
                {activeFilter && (
                  <button onClick={clearFilter} className="text-xs text-ink-muted hover:text-ink underline">
                    Clear filter
                  </button>
                )}
              </div>

              <p className="text-xs text-ink-muted mb-2 uppercase tracking-widest">Upcoming due date</p>
              <div className="flex flex-wrap gap-2 mb-5">
                {[5, 10, 15, 20, 25, 30].map((d) => (
                  <button
                    key={d}
                    onClick={() => loadFilter(`upcoming_${d}`, d)}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                      activeFilter === `upcoming_${d}`
                        ? 'bg-brand-500/20 border-brand-400 text-brand-600'
                        : 'border-surface-4 text-ink-muted'
                    }`}
                  >
                    Next {d} days
                  </button>
                ))}
              </div>

              {filteredEmis !== null && !filterLoading && (
                <div className="mt-6">
                  <div className="card overflow-hidden">
                    <table className="data-table">
                      <thead>
                        <tr><th>Customer</th><th>IMEI</th><th>Mobile</th><th>Retailer</th><th>EMI #</th><th>Due Date</th><th>Amount</th></tr>
                      </thead>
                      <tbody>
                        {filteredEmis.map((row) => (
                          <tr key={row.id}>
                            <td className="text-ink font-medium">{row.customer_name}</td>
                            <td><span className="font-num text-xs">{row.imei}</span></td>
                            <td><span className="font-num text-ink-muted">{row.mobile}</span></td>
                            <td>{row.retailer_name}</td>
                            <td>#{row.emi_no}</td>
                            <td>{format(new Date(row.due_date), 'd MMM yyyy')}</td>
                            <td>{fmt(row.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'broadcast' && (
          <div className="space-y-6 animate-fade-in">
            <h1 className="font-display text-3xl font-bold text-ink">Broadcast Message</h1>
            <div className="card p-6 space-y-4">
              <select
                value={broadcastRetailerId}
                onChange={(e) => setBroadcastRetailerId(e.target.value)}
                className="form-input"
              >
                <option value="">— Select retailer —</option>
                {retailers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <textarea
                value={broadcastMessage}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                rows={3}
                placeholder="Message for customers..."
                className="form-input"
              />
              <input
                type="date"
                value={broadcastExpiry}
                onChange={(e) => setBroadcastExpiry(e.target.value)}
                className="form-input"
              />
              <button
                onClick={async () => {
                  if (!broadcastRetailerId || !broadcastMessage.trim() || !broadcastExpiry) return;
                  setBroadcastLoading(true);
                  const res = await fetch('/api/broadcast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      target_retailer_id: broadcastRetailerId,
                      message: broadcastMessage.trim(),
                      expires_at: broadcastExpiry + 'T23:59:59Z',
                    }),
                  });
                  if (res.ok) { toast.success('Sent!'); setBroadcastMessage(''); loadBroadcasts(); }
                  setBroadcastLoading(false);
                }}
                disabled={broadcastLoading}
                className="btn-primary"
              >
                {broadcastLoading ? 'Sending…' : '📢 Send Broadcast'}
              </button>
            </div>
          </div>
        )}
      </div>

      {showCustomerForm && (
        <CustomerFormModal
          customer={editingCustomer}
          retailers={retailers}
          onClose={() => { setShowCustomerForm(false); setEditingCustomer(null); }}
          onSaved={refreshSelectedCustomer}
          isAdmin={true}
        />
      )}

      {showPaymentModal && selectedCustomer && breakdown && (
        <PaymentModal
          customer={selectedCustomer}
          emis={customerEmis}
          breakdown={breakdown}
          onClose={() => setShowPaymentModal(false)}
          onSubmitted={async () => { await refreshSelectedCustomer(); loadPendingCount(); }}
          isAdmin={true}
        />
      )}

      {showCompleteModal && (
        <div className="modal-backdrop">
          <div className="card w-full max-w-md p-6">
            <h3 className="font-display text-xl font-bold mb-5">Mark as COMPLETE</h3>
            <textarea
              value={completeRemark}
              onChange={(e) => setCompleteRemark(e.target.value)}
              rows={3}
              placeholder="Completion remark..."
              className="form-input mb-4"
            />
            <div className="flex gap-3">
              <button onClick={() => setShowCompleteModal(false)} className="btn-ghost flex-1">Cancel</button>
              <button onClick={handleMarkComplete} className="btn-success flex-1">Confirm</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="modal-backdrop">
          <div className="card w-full max-w-md p-6">
            <h3 className="font-display text-xl font-bold text-danger mb-5">Delete Customer</h3>
            <input
              value={deleteRemark}
              onChange={(e) => setDeleteRemark(e.target.value)}
              placeholder="Reason..."
              className="form-input mb-4"
            />
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteConfirm(false)} className="btn-ghost flex-1">Cancel</button>
              <button onClick={handleDeleteCustomer} className="btn-danger flex-1">Delete</button>
            </div>
          </div>
        </div>
      )}

      {showRetailerForm && (
        <div className="modal-backdrop">
          <div className="card w-full max-w-md p-6">
            <h3 className="font-display text-xl font-bold mb-5">
              {editingRetailer ? 'Edit Retailer' : 'Add Retailer'}
            </h3>
            <form onSubmit={handleRetailerSubmit} className="space-y-4">
              <input
                value={retailerForm.name}
                onChange={(e) => setRetailerForm(f => ({ ...f, name: e.target.value }))}
                required
                placeholder="Name"
                className="form-input"
              />
              {!editingRetailer && (
                <input
                  value={retailerForm.username}
                  onChange={(e) => setRetailerForm(f => ({ ...f, username: e.target.value.toLowerCase() }))}
                  required
                  placeholder="Username"
                  className="form-input"
                />
              )}
              <input
                type="password"
                value={retailerForm.password}
                onChange={(e) => setRetailerForm(f => ({ ...f, password: e.target.value }))}
                required={!editingRetailer}
                placeholder="Password"
                className="form-input"
              />
              <input
                type="text"
                value={retailerForm.retail_pin}
                onChange={(e) => setRetailerForm(f => ({ ...f, retail_pin: e.target.value.replace(/\D/g, '') }))}
                required={!editingRetailer}
                placeholder="PIN"
                className="form-input"
              />
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowRetailerForm(false)} className="btn-ghost flex-1">Cancel</button>
                <button type="submit" className="btn-primary flex-1">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
