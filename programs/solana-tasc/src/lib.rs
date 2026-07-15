#![cfg_attr(target_os = "solana", no_std)]

use core::{mem::size_of, slice};

#[cfg(target_os = "solana")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}

pub const TASK_ACCOUNT_DISCRIMINATOR: [u8; 8] = [0xfe, 0x5a, 0x9b, 0x1a, 0x20, 0xf0, 0x8f, 0x03];
pub const TASK_ACCOUNT_SIZE: usize = 276;
pub const FUND_INSTRUCTION_SIZE: usize = 121;
pub const ATTEST_INSTRUCTION_SIZE: usize = 34;
pub const VERSION: u8 = 1;
pub const RUNTIME_MIN_ACCOUNTS: usize = 2;
pub const RUNTIME_FUND_ACCOUNTS: usize = 5;
pub const NON_DUP_MARKER: u8 = u8::MAX;
pub const BPF_ALIGN_OF_U128: usize = 8;
pub const MAX_PERMITTED_DATA_INCREASE: usize = 1_024 * 10;

pub const TAG_FUND: u8 = 0;
pub const TAG_CLAIM: u8 = 1;
pub const TAG_ATTEST: u8 = 2;
pub const TAG_RELEASE: u8 = 3;
pub const TAG_REFUND: u8 = 4;
pub const TAG_OPEN_DISPUTE: u8 = 5;

pub const STATUS_EMPTY: u8 = 0;
pub const STATUS_FUNDED: u8 = 1;
pub const STATUS_CLAIMED: u8 = 2;
pub const STATUS_PASSED: u8 = 3;
pub const STATUS_FAILED: u8 = 4;
pub const STATUS_RELEASED: u8 = 5;
pub const STATUS_REFUNDED: u8 = 6;
pub const STATUS_DISPUTED: u8 = 7;

pub const TASK_HASH_OFFSET: usize = 12;
pub const BUYER_OFFSET: usize = 44;
pub const WORKER_OFFSET: usize = 76;
pub const VERIFIER_OFFSET: usize = 108;
pub const TOKEN_MINT_OFFSET: usize = 140;
pub const VAULT_OFFSET: usize = 172;
pub const AMOUNT_OFFSET: usize = 204;
pub const DEADLINE_UNIX_OFFSET: usize = 212;
pub const NONCE_OFFSET: usize = 220;
pub const RESULT_HASH_OFFSET: usize = 228;
pub const CREATED_SLOT_OFFSET: usize = 260;
pub const UPDATED_SLOT_OFFSET: usize = 268;

pub type PubkeyBytes = [u8; 32];
pub type HashBytes = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum TascError {
    InvalidLength = 1,
    InvalidDiscriminator = 2,
    InvalidVersion = 3,
    InvalidStatus = 4,
    InvalidInstruction = 5,
    AlreadyInitialized = 6,
    NotFunded = 7,
    MissingAccount = 8,
    InvalidSigner = 9,
    InvalidWritable = 10,
    InvalidOwner = 11,
    InvalidAccount = 12,
    DuplicateAccount = 13,
}

#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    process_entrypoint(input) as u64
}

unsafe fn process_entrypoint(input: *mut u8) -> u64 {
    if input.is_null() {
        return TascError::InvalidAccount as u64;
    }
    match process_serialized_runtime_input(input) {
        Ok(()) => 0,
        Err(error) => error as u64,
    }
}

#[derive(Clone, Copy)]
struct RuntimeAccounts {
    signer_key: PubkeyBytes,
    signer_signer: bool,
    signer_writable: bool,
    task_owner: PubkeyBytes,
    task_writable: bool,
    task_data: *mut u8,
    task_data_len: usize,
    vault_key: PubkeyBytes,
    vault_writable: bool,
    token_mint_key: PubkeyBytes,
    verifier_key: PubkeyBytes,
}

impl RuntimeAccounts {
    fn empty() -> Self {
        Self {
            signer_key: [0u8; 32],
            signer_signer: false,
            signer_writable: false,
            task_owner: [0u8; 32],
            task_writable: false,
            task_data: core::ptr::null_mut(),
            task_data_len: 0,
            vault_key: [0u8; 32],
            vault_writable: false,
            token_mint_key: [0u8; 32],
            verifier_key: [0u8; 32],
        }
    }
}

unsafe fn process_serialized_runtime_input(input: *mut u8) -> Result<(), TascError> {
    let mut offset = 0usize;
    let num_accounts = read_runtime_u64(input, &mut offset) as usize;
    if num_accounts < RUNTIME_MIN_ACCOUNTS {
        return Err(TascError::MissingAccount);
    }

    let mut accounts = RuntimeAccounts::empty();
    for index in 0..num_accounts {
        let duplicate_marker = read_runtime_u8(input, &mut offset);
        if duplicate_marker != NON_DUP_MARKER {
            offset += 7;
            if index < RUNTIME_MIN_ACCOUNTS {
                return Err(TascError::DuplicateAccount);
            }
            continue;
        }
        offset = read_runtime_account(input, offset, index, &mut accounts)?;
    }

    let instruction_data_len = read_runtime_u64(input, &mut offset) as usize;
    let instruction_data = slice::from_raw_parts(input.add(offset), instruction_data_len);
    offset += instruction_data_len;

    let program_id = read_runtime_pubkey(input, &mut offset);
    match instruction_data.first().copied() {
        Some(TAG_FUND) => {
            process_fund_runtime(&program_id, &accounts, num_accounts, instruction_data)
        }
        Some(TAG_CLAIM) => {
            process_claim_runtime(&program_id, &accounts, num_accounts, instruction_data)
        }
        Some(TAG_ATTEST) => {
            process_attest_runtime(&program_id, &accounts, num_accounts, instruction_data)
        }
        Some(TAG_RELEASE) => {
            process_release_runtime(&program_id, &accounts, num_accounts, instruction_data)
        }
        Some(TAG_REFUND) => {
            process_refund_runtime(&program_id, &accounts, num_accounts, instruction_data)
        }
        _ => Err(TascError::InvalidInstruction),
    }
}

unsafe fn read_runtime_account(
    input: *mut u8,
    mut offset: usize,
    index: usize,
    accounts: &mut RuntimeAccounts,
) -> Result<usize, TascError> {
    let is_signer = read_runtime_u8(input, &mut offset) != 0;
    let is_writable = read_runtime_u8(input, &mut offset) != 0;
    let _executable = read_runtime_u8(input, &mut offset);
    offset += size_of::<u32>();

    let key = read_runtime_pubkey(input, &mut offset);
    let owner = read_runtime_pubkey(input, &mut offset);
    offset += size_of::<u64>();

    let data_len = read_runtime_u64(input, &mut offset) as usize;
    let data = input.add(offset);

    match index {
        0 => {
            accounts.signer_key = key;
            accounts.signer_signer = is_signer;
            accounts.signer_writable = is_writable;
        }
        1 => {
            accounts.task_owner = owner;
            accounts.task_writable = is_writable;
            accounts.task_data = data;
            accounts.task_data_len = data_len;
        }
        2 => {
            accounts.vault_key = key;
            accounts.vault_writable = is_writable;
        }
        3 => {
            accounts.token_mint_key = key;
        }
        4 => {
            accounts.verifier_key = key;
        }
        _ => {}
    }

    offset += data_len + MAX_PERMITTED_DATA_INCREASE + size_of::<u64>();
    Ok(align_runtime_offset(offset))
}

fn process_fund_runtime(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
    account_count: usize,
    instruction_data: &[u8],
) -> Result<(), TascError> {
    if account_count < RUNTIME_FUND_ACCOUNTS {
        return Err(TascError::MissingAccount);
    }
    let ix = decode_fund_instruction(instruction_data)?;
    if ix.amount == 0 {
        return Err(TascError::InvalidInstruction);
    }
    if !accounts.signer_signer {
        return Err(TascError::InvalidSigner);
    }
    if !accounts.signer_writable || !accounts.task_writable || !accounts.vault_writable {
        return Err(TascError::InvalidWritable);
    }
    validate_task_metadata(program_id, accounts)?;
    if accounts.token_mint_key != ix.token_mint || accounts.verifier_key != ix.verifier {
        return Err(TascError::InvalidAccount);
    }

    let task_data =
        unsafe { slice::from_raw_parts_mut(accounts.task_data, accounts.task_data_len) };
    if !is_zeroed(task_data) {
        return Err(TascError::AlreadyInitialized);
    }

    let account = build_funded_task_account(&ix, accounts.signer_key, accounts.vault_key, 0);
    encode_task_account(&account, task_data)
}

fn process_claim_runtime(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
    account_count: usize,
    instruction_data: &[u8],
) -> Result<(), TascError> {
    decode_unit_instruction(instruction_data, TAG_CLAIM)?;
    validate_lifecycle_accounts(program_id, accounts, account_count)?;
    let task_data =
        unsafe { slice::from_raw_parts_mut(accounts.task_data, accounts.task_data_len) };
    let mut account = decode_task_account(task_data)?;
    apply_claim(&mut account, accounts.signer_key, 0)?;
    encode_task_account(&account, task_data)
}

fn process_attest_runtime(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
    account_count: usize,
    instruction_data: &[u8],
) -> Result<(), TascError> {
    validate_lifecycle_accounts(program_id, accounts, account_count)?;
    let ix = decode_attest_instruction(instruction_data)?;
    let task_data =
        unsafe { slice::from_raw_parts_mut(accounts.task_data, accounts.task_data_len) };
    let mut account = decode_task_account(task_data)?;
    if account.verifier != accounts.signer_key {
        return Err(TascError::InvalidSigner);
    }
    apply_attest(&mut account, &ix, 0)?;
    encode_task_account(&account, task_data)
}

fn process_release_runtime(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
    account_count: usize,
    instruction_data: &[u8],
) -> Result<(), TascError> {
    decode_unit_instruction(instruction_data, TAG_RELEASE)?;
    validate_lifecycle_accounts(program_id, accounts, account_count)?;
    let task_data =
        unsafe { slice::from_raw_parts_mut(accounts.task_data, accounts.task_data_len) };
    let mut account = decode_task_account(task_data)?;
    apply_release(&mut account, 0)?;
    encode_task_account(&account, task_data)
}

fn process_refund_runtime(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
    account_count: usize,
    instruction_data: &[u8],
) -> Result<(), TascError> {
    decode_unit_instruction(instruction_data, TAG_REFUND)?;
    validate_lifecycle_accounts(program_id, accounts, account_count)?;
    let task_data =
        unsafe { slice::from_raw_parts_mut(accounts.task_data, accounts.task_data_len) };
    let mut account = decode_task_account(task_data)?;
    if account.buyer != accounts.signer_key {
        return Err(TascError::InvalidSigner);
    }
    apply_refund(&mut account, 0)?;
    encode_task_account(&account, task_data)
}

fn decode_unit_instruction(data: &[u8], tag: u8) -> Result<(), TascError> {
    if data.len() != 1 || data[0] != tag {
        return Err(TascError::InvalidInstruction);
    }
    Ok(())
}

fn validate_lifecycle_accounts(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
    account_count: usize,
) -> Result<(), TascError> {
    if account_count < RUNTIME_MIN_ACCOUNTS {
        return Err(TascError::MissingAccount);
    }
    if !accounts.signer_signer {
        return Err(TascError::InvalidSigner);
    }
    validate_task_metadata(program_id, accounts)
}

fn validate_task_metadata(
    program_id: &PubkeyBytes,
    accounts: &RuntimeAccounts,
) -> Result<(), TascError> {
    if !accounts.task_writable {
        return Err(TascError::InvalidWritable);
    }
    if accounts.task_owner != *program_id {
        return Err(TascError::InvalidOwner);
    }
    if accounts.task_data.is_null() || accounts.task_data_len != TASK_ACCOUNT_SIZE {
        return Err(TascError::InvalidLength);
    }
    Ok(())
}

fn is_zeroed(data: &[u8]) -> bool {
    data.iter().all(|byte| *byte == 0)
}

unsafe fn read_runtime_u8(input: *mut u8, offset: &mut usize) -> u8 {
    let value = *input.add(*offset);
    *offset += size_of::<u8>();
    value
}

unsafe fn read_runtime_u64(input: *mut u8, offset: &mut usize) -> u64 {
    let value = *(input.add(*offset) as *const u64);
    *offset += size_of::<u64>();
    value
}

unsafe fn read_runtime_pubkey(input: *mut u8, offset: &mut usize) -> PubkeyBytes {
    let value = read_32(slice::from_raw_parts(input.add(*offset), 32), 0);
    *offset += 32;
    value
}

fn align_runtime_offset(offset: usize) -> usize {
    let remainder = offset % BPF_ALIGN_OF_U128;
    if remainder == 0 {
        offset
    } else {
        offset + (BPF_ALIGN_OF_U128 - remainder)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskAccount {
    pub status: u8,
    pub bump: u8,
    pub flags: u8,
    pub task_hash: HashBytes,
    pub buyer: PubkeyBytes,
    pub worker: PubkeyBytes,
    pub verifier: PubkeyBytes,
    pub token_mint: PubkeyBytes,
    pub vault: PubkeyBytes,
    pub amount: u64,
    pub deadline_unix: u64,
    pub nonce: u64,
    pub result_hash: HashBytes,
    pub created_slot: u64,
    pub updated_slot: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundInstruction {
    pub task_hash: HashBytes,
    pub amount: u64,
    pub deadline_unix: u64,
    pub nonce: u64,
    pub token_mint: PubkeyBytes,
    pub verifier: PubkeyBytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestInstruction {
    pub passed: bool,
    pub result_hash: HashBytes,
}

pub fn decode_task_account(data: &[u8]) -> Result<TaskAccount, TascError> {
    if data.len() != TASK_ACCOUNT_SIZE {
        return Err(TascError::InvalidLength);
    }
    if data[0..8] != TASK_ACCOUNT_DISCRIMINATOR {
        return Err(TascError::InvalidDiscriminator);
    }
    if data[8] != VERSION {
        return Err(TascError::InvalidVersion);
    }
    validate_status(data[9])?;
    Ok(TaskAccount {
        status: data[9],
        bump: data[10],
        flags: data[11],
        task_hash: read_32(data, TASK_HASH_OFFSET),
        buyer: read_32(data, BUYER_OFFSET),
        worker: read_32(data, WORKER_OFFSET),
        verifier: read_32(data, VERIFIER_OFFSET),
        token_mint: read_32(data, TOKEN_MINT_OFFSET),
        vault: read_32(data, VAULT_OFFSET),
        amount: read_u64(data, AMOUNT_OFFSET),
        deadline_unix: read_u64(data, DEADLINE_UNIX_OFFSET),
        nonce: read_u64(data, NONCE_OFFSET),
        result_hash: read_32(data, RESULT_HASH_OFFSET),
        created_slot: read_u64(data, CREATED_SLOT_OFFSET),
        updated_slot: read_u64(data, UPDATED_SLOT_OFFSET),
    })
}

pub fn encode_task_account(account: &TaskAccount, out: &mut [u8]) -> Result<(), TascError> {
    if out.len() != TASK_ACCOUNT_SIZE {
        return Err(TascError::InvalidLength);
    }
    validate_status(account.status)?;
    out.fill(0);
    out[0..8].copy_from_slice(&TASK_ACCOUNT_DISCRIMINATOR);
    out[8] = VERSION;
    out[9] = account.status;
    out[10] = account.bump;
    out[11] = account.flags;
    write_32(out, TASK_HASH_OFFSET, &account.task_hash);
    write_32(out, BUYER_OFFSET, &account.buyer);
    write_32(out, WORKER_OFFSET, &account.worker);
    write_32(out, VERIFIER_OFFSET, &account.verifier);
    write_32(out, TOKEN_MINT_OFFSET, &account.token_mint);
    write_32(out, VAULT_OFFSET, &account.vault);
    write_u64(out, AMOUNT_OFFSET, account.amount);
    write_u64(out, DEADLINE_UNIX_OFFSET, account.deadline_unix);
    write_u64(out, NONCE_OFFSET, account.nonce);
    write_32(out, RESULT_HASH_OFFSET, &account.result_hash);
    write_u64(out, CREATED_SLOT_OFFSET, account.created_slot);
    write_u64(out, UPDATED_SLOT_OFFSET, account.updated_slot);
    Ok(())
}

pub fn decode_fund_instruction(data: &[u8]) -> Result<FundInstruction, TascError> {
    if data.len() != FUND_INSTRUCTION_SIZE {
        return Err(TascError::InvalidLength);
    }
    if data[0] != TAG_FUND {
        return Err(TascError::InvalidInstruction);
    }
    Ok(FundInstruction {
        task_hash: read_32(data, 1),
        amount: read_u64(data, 33),
        deadline_unix: read_u64(data, 41),
        nonce: read_u64(data, 49),
        token_mint: read_32(data, 57),
        verifier: read_32(data, 89),
    })
}

pub fn decode_attest_instruction(data: &[u8]) -> Result<AttestInstruction, TascError> {
    if data.len() != ATTEST_INSTRUCTION_SIZE {
        return Err(TascError::InvalidLength);
    }
    if data[0] != TAG_ATTEST {
        return Err(TascError::InvalidInstruction);
    }
    Ok(AttestInstruction {
        passed: data[1] == 1,
        result_hash: read_32(data, 2),
    })
}

pub fn build_funded_task_account(
    ix: &FundInstruction,
    buyer: PubkeyBytes,
    vault: PubkeyBytes,
    created_slot: u64,
) -> TaskAccount {
    TaskAccount {
        status: STATUS_FUNDED,
        bump: 0,
        flags: 0,
        task_hash: ix.task_hash,
        buyer,
        worker: [0u8; 32],
        verifier: ix.verifier,
        token_mint: ix.token_mint,
        vault,
        amount: ix.amount,
        deadline_unix: ix.deadline_unix,
        nonce: ix.nonce,
        result_hash: [0u8; 32],
        created_slot,
        updated_slot: created_slot,
    }
}

pub fn apply_claim(
    account: &mut TaskAccount,
    worker: PubkeyBytes,
    slot: u64,
) -> Result<(), TascError> {
    if account.status != STATUS_FUNDED {
        return Err(TascError::NotFunded);
    }
    account.status = STATUS_CLAIMED;
    account.worker = worker;
    account.updated_slot = slot;
    Ok(())
}

pub fn apply_attest(
    account: &mut TaskAccount,
    ix: &AttestInstruction,
    slot: u64,
) -> Result<(), TascError> {
    if account.status != STATUS_CLAIMED {
        return Err(TascError::InvalidStatus);
    }
    account.status = if ix.passed {
        STATUS_PASSED
    } else {
        STATUS_FAILED
    };
    account.result_hash = ix.result_hash;
    account.updated_slot = slot;
    Ok(())
}

pub fn apply_release(account: &mut TaskAccount, slot: u64) -> Result<(), TascError> {
    if account.status != STATUS_PASSED {
        return Err(TascError::InvalidStatus);
    }
    account.status = STATUS_RELEASED;
    account.updated_slot = slot;
    Ok(())
}

pub fn apply_refund(account: &mut TaskAccount, slot: u64) -> Result<(), TascError> {
    if account.status != STATUS_FAILED {
        return Err(TascError::InvalidStatus);
    }
    account.status = STATUS_REFUNDED;
    account.updated_slot = slot;
    Ok(())
}

fn validate_status(status: u8) -> Result<(), TascError> {
    if status <= STATUS_DISPUTED {
        Ok(())
    } else {
        Err(TascError::InvalidStatus)
    }
}

fn read_32(data: &[u8], offset: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[offset..offset + 32]);
    out
}

fn write_32(out: &mut [u8], offset: usize, value: &[u8; 32]) {
    out[offset..offset + 32].copy_from_slice(value);
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&data[offset..offset + 8]);
    u64::from_le_bytes(raw)
}

fn write_u64(out: &mut [u8], offset: usize, value: u64) {
    out[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use std::vec::Vec;

    fn key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    struct TestAccount {
        key: PubkeyBytes,
        owner: PubkeyBytes,
        is_signer: bool,
        is_writable: bool,
        data: Vec<u8>,
    }

    impl TestAccount {
        fn new(
            key: PubkeyBytes,
            owner: PubkeyBytes,
            is_signer: bool,
            is_writable: bool,
            data_len: usize,
        ) -> Self {
            Self {
                key,
                owner,
                is_signer,
                is_writable,
                data: vec![0u8; data_len],
            }
        }
    }

    fn fund_instruction_bytes(
        task_hash: HashBytes,
        amount: u64,
        deadline_unix: u64,
        nonce: u64,
        token_mint: PubkeyBytes,
        verifier: PubkeyBytes,
    ) -> [u8; FUND_INSTRUCTION_SIZE] {
        let mut data = [0u8; FUND_INSTRUCTION_SIZE];
        data[0] = TAG_FUND;
        data[1..33].copy_from_slice(&task_hash);
        data[33..41].copy_from_slice(&amount.to_le_bytes());
        data[41..49].copy_from_slice(&deadline_unix.to_le_bytes());
        data[49..57].copy_from_slice(&nonce.to_le_bytes());
        data[57..89].copy_from_slice(&token_mint);
        data[89..121].copy_from_slice(&verifier);
        data
    }

    fn attest_instruction_bytes(
        passed: bool,
        result_hash: HashBytes,
    ) -> [u8; ATTEST_INSTRUCTION_SIZE] {
        let mut data = [0u8; ATTEST_INSTRUCTION_SIZE];
        data[0] = TAG_ATTEST;
        data[1] = u8::from(passed);
        data[2..34].copy_from_slice(&result_hash);
        data
    }

    fn funded_account_data(
        buyer: PubkeyBytes,
        vault: PubkeyBytes,
        token_mint: PubkeyBytes,
        verifier: PubkeyBytes,
    ) -> Vec<u8> {
        let ix = FundInstruction {
            task_hash: key(1),
            amount: 10_000_000,
            deadline_unix: 1_800_000_060,
            nonce: 1,
            token_mint,
            verifier,
        };
        let account = build_funded_task_account(&ix, buyer, vault, 42);
        let mut data = vec![0u8; TASK_ACCOUNT_SIZE];
        encode_task_account(&account, &mut data).unwrap();
        let decoded = decode_task_account(&data).unwrap();
        assert_eq!(decoded.buyer, buyer);
        assert_eq!(decoded.vault, vault);
        data
    }

    fn claimed_account_data(
        buyer: PubkeyBytes,
        worker: PubkeyBytes,
        vault: PubkeyBytes,
        token_mint: PubkeyBytes,
        verifier: PubkeyBytes,
    ) -> Vec<u8> {
        let mut data = funded_account_data(buyer, vault, token_mint, verifier);
        let mut account = decode_task_account(&data).unwrap();
        apply_claim(&mut account, worker, 43).unwrap();
        encode_task_account(&account, &mut data).unwrap();
        data
    }

    fn passed_account_data(
        buyer: PubkeyBytes,
        worker: PubkeyBytes,
        vault: PubkeyBytes,
        token_mint: PubkeyBytes,
        verifier: PubkeyBytes,
        result_hash: HashBytes,
    ) -> Vec<u8> {
        let mut data = claimed_account_data(buyer, worker, vault, token_mint, verifier);
        let mut account = decode_task_account(&data).unwrap();
        apply_attest(
            &mut account,
            &AttestInstruction {
                passed: true,
                result_hash,
            },
            44,
        )
        .unwrap();
        encode_task_account(&account, &mut data).unwrap();
        data
    }

    fn failed_account_data(
        buyer: PubkeyBytes,
        worker: PubkeyBytes,
        vault: PubkeyBytes,
        token_mint: PubkeyBytes,
        verifier: PubkeyBytes,
        result_hash: HashBytes,
    ) -> Vec<u8> {
        let mut data = claimed_account_data(buyer, worker, vault, token_mint, verifier);
        let mut account = decode_task_account(&data).unwrap();
        apply_attest(
            &mut account,
            &AttestInstruction {
                passed: false,
                result_hash,
            },
            44,
        )
        .unwrap();
        encode_task_account(&account, &mut data).unwrap();
        data
    }

    fn push_u64(out: &mut Vec<u8>, value: u64) {
        out.extend_from_slice(&value.to_le_bytes());
    }

    fn push_runtime_account(out: &mut Vec<u8>, account: &TestAccount) {
        out.push(NON_DUP_MARKER);
        out.push(u8::from(account.is_signer));
        out.push(u8::from(account.is_writable));
        out.push(0);
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&account.key);
        out.extend_from_slice(&account.owner);
        push_u64(out, 1);
        push_u64(out, account.data.len() as u64);
        out.extend_from_slice(&account.data);
        out.extend_from_slice(&vec![0u8; MAX_PERMITTED_DATA_INCREASE]);
        push_u64(out, 0);
        while out.len() % BPF_ALIGN_OF_U128 != 0 {
            out.push(0);
        }
    }

    fn serialized_runtime_input(
        accounts: &[TestAccount],
        instruction_data: &[u8],
        program_id: PubkeyBytes,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        push_u64(&mut out, accounts.len() as u64);
        for account in accounts {
            push_runtime_account(&mut out, account);
        }
        push_u64(&mut out, instruction_data.len() as u64);
        out.extend_from_slice(instruction_data);
        out.extend_from_slice(&program_id);
        out
    }

    fn data_offset_for_account(input: &[u8], target_index: usize) -> usize {
        let mut offset = size_of::<u64>();
        for index in 0..=target_index {
            assert_eq!(input[offset], NON_DUP_MARKER);
            offset += size_of::<u8>();
            offset += 3;
            offset += size_of::<u32>();
            offset += 32;
            offset += 32;
            offset += size_of::<u64>();
            let data_len =
                u64::from_le_bytes(input[offset..offset + 8].try_into().unwrap()) as usize;
            offset += size_of::<u64>();
            if index == target_index {
                return offset;
            }
            offset += data_len + MAX_PERMITTED_DATA_INCREASE + size_of::<u64>();
            offset = align_runtime_offset(offset);
        }
        unreachable!()
    }

    #[test]
    fn layout_sizes_match_scanner_abi() {
        assert_eq!(TASK_ACCOUNT_SIZE, 276);
        assert_eq!(FUND_INSTRUCTION_SIZE, 121);
        assert_eq!(
            TASK_ACCOUNT_DISCRIMINATOR,
            [0xfe, 0x5a, 0x9b, 0x1a, 0x20, 0xf0, 0x8f, 0x03]
        );
        assert_eq!(AMOUNT_OFFSET, 204);
        assert_eq!(UPDATED_SLOT_OFFSET, 268);
    }

    #[test]
    fn fund_instruction_decodes() {
        let data = fund_instruction_bytes(key(1), 10_000_000, 1_800_000_060, 1, key(2), key(3));

        let ix = decode_fund_instruction(&data).unwrap();
        assert_eq!(ix.task_hash, key(1));
        assert_eq!(ix.amount, 10_000_000);
        assert_eq!(ix.deadline_unix, 1_800_000_060);
        assert_eq!(ix.nonce, 1);
        assert_eq!(ix.token_mint, key(2));
        assert_eq!(ix.verifier, key(3));
    }

    #[test]
    fn funded_task_account_round_trips() {
        let ix = FundInstruction {
            task_hash: key(1),
            amount: 10_000_000,
            deadline_unix: 1_800_000_060,
            nonce: 1,
            token_mint: key(2),
            verifier: key(3),
        };
        let account = build_funded_task_account(&ix, key(4), key(5), 42);

        let mut encoded = [0u8; TASK_ACCOUNT_SIZE];
        encode_task_account(&account, &mut encoded).unwrap();
        let decoded = decode_task_account(&encoded).unwrap();

        assert_eq!(decoded.status, STATUS_FUNDED);
        assert_eq!(decoded.task_hash, key(1));
        assert_eq!(decoded.buyer, key(4));
        assert_eq!(decoded.vault, key(5));
        assert_eq!(decoded.amount, 10_000_000);
        assert_eq!(decoded.created_slot, 42);
        assert_eq!(decoded.updated_slot, 42);
    }

    #[test]
    fn lifecycle_transitions_update_status() {
        let ix = FundInstruction {
            task_hash: key(1),
            amount: 10_000_000,
            deadline_unix: 1_800_000_060,
            nonce: 1,
            token_mint: key(2),
            verifier: key(3),
        };
        let mut account = build_funded_task_account(&ix, key(4), key(5), 42);

        apply_claim(&mut account, key(6), 43).unwrap();
        assert_eq!(account.status, STATUS_CLAIMED);
        assert_eq!(account.worker, key(6));

        let attestation = AttestInstruction {
            passed: true,
            result_hash: key(7),
        };
        apply_attest(&mut account, &attestation, 44).unwrap();
        assert_eq!(account.status, STATUS_PASSED);
        assert_eq!(account.result_hash, key(7));

        apply_release(&mut account, 45).unwrap();
        assert_eq!(account.status, STATUS_RELEASED);
        assert_eq!(account.updated_slot, 45);
    }

    #[test]
    fn refund_transition_requires_failed_status() {
        let ix = FundInstruction {
            task_hash: key(1),
            amount: 10_000_000,
            deadline_unix: 1_800_000_060,
            nonce: 1,
            token_mint: key(2),
            verifier: key(3),
        };
        let mut account = build_funded_task_account(&ix, key(4), key(5), 42);
        apply_claim(&mut account, key(6), 43).unwrap();
        let attestation = AttestInstruction {
            passed: false,
            result_hash: key(7),
        };
        apply_attest(&mut account, &attestation, 44).unwrap();
        apply_refund(&mut account, 45).unwrap();
        assert_eq!(account.status, STATUS_REFUNDED);
        assert_eq!(account.updated_slot, 45);
    }

    #[test]
    fn entrypoint_fund_instruction_writes_task_account() {
        let program_id = key(9);
        let buyer = key(4);
        let task = key(8);
        let vault = key(5);
        let token_mint = key(2);
        let verifier = key(3);
        let instruction =
            fund_instruction_bytes(key(1), 10_000_000, 1_800_000_060, 1, token_mint, verifier);
        let accounts = [
            TestAccount::new(buyer, key(0), true, true, 0),
            TestAccount::new(task, program_id, false, true, TASK_ACCOUNT_SIZE),
            TestAccount::new(vault, key(0), false, true, 0),
            TestAccount::new(token_mint, key(0), false, false, 0),
            TestAccount::new(verifier, key(0), false, false, 0),
        ];
        let mut input = serialized_runtime_input(&accounts, &instruction, program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, 0);

        let task_data_offset = data_offset_for_account(&input, 1);
        let decoded =
            decode_task_account(&input[task_data_offset..task_data_offset + TASK_ACCOUNT_SIZE])
                .unwrap();
        assert_eq!(decoded.status, STATUS_FUNDED);
        assert_eq!(decoded.task_hash, key(1));
        assert_eq!(decoded.buyer, buyer);
        assert_eq!(decoded.worker, [0u8; 32]);
        assert_eq!(decoded.verifier, verifier);
        assert_eq!(decoded.token_mint, token_mint);
        assert_eq!(decoded.vault, vault);
        assert_eq!(decoded.amount, 10_000_000);
        assert_eq!(decoded.deadline_unix, 1_800_000_060);
        assert_eq!(decoded.nonce, 1);
        assert_eq!(decoded.created_slot, 0);
        assert_eq!(decoded.updated_slot, 0);
    }

    #[test]
    fn entrypoint_rejects_non_signing_buyer() {
        let program_id = key(9);
        let instruction =
            fund_instruction_bytes(key(1), 10_000_000, 1_800_000_060, 1, key(2), key(3));
        let accounts = [
            TestAccount::new(key(4), key(0), false, true, 0),
            TestAccount::new(key(8), program_id, false, true, TASK_ACCOUNT_SIZE),
            TestAccount::new(key(5), key(0), false, true, 0),
            TestAccount::new(key(2), key(0), false, false, 0),
            TestAccount::new(key(3), key(0), false, false, 0),
        ];
        let mut input = serialized_runtime_input(&accounts, &instruction, program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, TascError::InvalidSigner as u64);
    }

    #[test]
    fn entrypoint_rejects_task_account_not_owned_by_program() {
        let program_id = key(9);
        let instruction =
            fund_instruction_bytes(key(1), 10_000_000, 1_800_000_060, 1, key(2), key(3));
        let accounts = [
            TestAccount::new(key(4), key(0), true, true, 0),
            TestAccount::new(key(8), key(7), false, true, TASK_ACCOUNT_SIZE),
            TestAccount::new(key(5), key(0), false, true, 0),
            TestAccount::new(key(2), key(0), false, false, 0),
            TestAccount::new(key(3), key(0), false, false, 0),
        ];
        let mut input = serialized_runtime_input(&accounts, &instruction, program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, TascError::InvalidOwner as u64);
    }

    #[test]
    fn entrypoint_claim_instruction_updates_worker() {
        let program_id = key(9);
        let buyer = key(4);
        let worker = key(6);
        let task = key(8);
        let verifier = key(3);
        let accounts = [
            TestAccount {
                key: worker,
                owner: key(0),
                is_signer: true,
                is_writable: true,
                data: Vec::new(),
            },
            TestAccount::new(task, program_id, false, true, TASK_ACCOUNT_SIZE),
        ];
        let mut accounts = accounts;
        accounts[1].data = funded_account_data(buyer, key(5), key(2), verifier);
        let mut input = serialized_runtime_input(&accounts, &[TAG_CLAIM], program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, 0);

        let task_data_offset = data_offset_for_account(&input, 1);
        let decoded =
            decode_task_account(&input[task_data_offset..task_data_offset + TASK_ACCOUNT_SIZE])
                .unwrap();
        assert_eq!(decoded.status, STATUS_CLAIMED);
        assert_eq!(decoded.worker, worker);
        assert_eq!(decoded.updated_slot, 0);
    }

    #[test]
    fn entrypoint_attest_instruction_requires_verifier() {
        let program_id = key(9);
        let buyer = key(4);
        let worker = key(6);
        let verifier = key(3);
        let task = key(8);
        let instruction = attest_instruction_bytes(true, key(7));
        let accounts = [
            TestAccount {
                key: verifier,
                owner: key(0),
                is_signer: true,
                is_writable: true,
                data: Vec::new(),
            },
            TestAccount {
                key: task,
                owner: program_id,
                is_signer: false,
                is_writable: true,
                data: claimed_account_data(buyer, worker, key(5), key(2), verifier),
            },
        ];
        let mut input = serialized_runtime_input(&accounts, &instruction, program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, 0);

        let task_data_offset = data_offset_for_account(&input, 1);
        let decoded =
            decode_task_account(&input[task_data_offset..task_data_offset + TASK_ACCOUNT_SIZE])
                .unwrap();
        assert_eq!(decoded.status, STATUS_PASSED);
        assert_eq!(decoded.result_hash, key(7));
    }

    #[test]
    fn entrypoint_release_instruction_requires_passed_status() {
        let program_id = key(9);
        let buyer = key(4);
        let worker = key(6);
        let verifier = key(3);
        let task = key(8);
        let accounts = [
            TestAccount {
                key: worker,
                owner: key(0),
                is_signer: true,
                is_writable: true,
                data: Vec::new(),
            },
            TestAccount {
                key: task,
                owner: program_id,
                is_signer: false,
                is_writable: true,
                data: passed_account_data(buyer, worker, key(5), key(2), verifier, key(7)),
            },
        ];
        let mut input = serialized_runtime_input(&accounts, &[TAG_RELEASE], program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, 0);

        let task_data_offset = data_offset_for_account(&input, 1);
        let decoded =
            decode_task_account(&input[task_data_offset..task_data_offset + TASK_ACCOUNT_SIZE])
                .unwrap();
        assert_eq!(decoded.status, STATUS_RELEASED);
    }

    #[test]
    fn entrypoint_refund_instruction_requires_buyer_and_failed_status() {
        let program_id = key(9);
        let buyer = key(4);
        let worker = key(6);
        let verifier = key(3);
        let task = key(8);
        let accounts = [
            TestAccount {
                key: buyer,
                owner: key(0),
                is_signer: true,
                is_writable: true,
                data: Vec::new(),
            },
            TestAccount {
                key: task,
                owner: program_id,
                is_signer: false,
                is_writable: true,
                data: failed_account_data(buyer, worker, key(5), key(2), verifier, key(7)),
            },
        ];
        let mut input = serialized_runtime_input(&accounts, &[TAG_REFUND], program_id);

        let status = unsafe { entrypoint(input.as_mut_ptr()) };
        assert_eq!(status, 0);

        let task_data_offset = data_offset_for_account(&input, 1);
        let decoded =
            decode_task_account(&input[task_data_offset..task_data_offset + TASK_ACCOUNT_SIZE])
                .unwrap();
        assert_eq!(decoded.status, STATUS_REFUNDED);
    }
}
