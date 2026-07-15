// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract TascEscrow {
    enum Status {
        None,
        Funded,
        Claimed,
        Passed,
        Failed,
        Released,
        Refunded,
        Disputed
    }

    struct Task {
        address buyer;
        address worker;
        address token;
        address verifier;
        uint256 amount;
        uint64 deadline;
        bytes32 resultHash;
        Status status;
    }

    address public owner;
    bool private locked;

    mapping(address => bool) public verifiers;
    mapping(bytes32 => Task) public tasks;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierSet(address indexed verifier, bool allowed);
    event Funded(bytes32 indexed taskHash, address indexed buyer, address indexed token, uint256 amount, uint64 deadline);
    event Claimed(bytes32 indexed taskHash, address indexed worker);
    event Attested(bytes32 indexed taskHash, address indexed verifier, bytes32 indexed resultHash, bool passed);
    event Released(bytes32 indexed taskHash, address indexed worker, uint256 amount);
    event Refunded(bytes32 indexed taskHash, address indexed buyer, uint256 amount);
    event Disputed(bytes32 indexed taskHash, address indexed openedBy);
    event DisputeResolved(bytes32 indexed taskHash, bool releaseToWorker);

    error NotOwner();
    error NotVerifier();
    error ReentrantCall();
    error InvalidTaskHash();
    error InvalidToken();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidStatus(Status actual, Status expected);
    error MissingWorker();
    error NotParticipant();
    error DeadlineNotReached();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyVerifier() {
        if (!verifiers[msg.sender]) revert NotVerifier();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert ReentrantCall();
        locked = true;
        _;
        locked = false;
    }

    constructor(address initialVerifier) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        if (initialVerifier != address(0)) {
            verifiers[initialVerifier] = true;
            emit VerifierSet(initialVerifier, true);
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert NotParticipant();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        if (verifier == address(0)) revert NotVerifier();
        verifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    function fund(bytes32 taskHash, address token, uint256 amount, uint64 deadline) external nonReentrant {
        if (taskHash == bytes32(0)) revert InvalidTaskHash();
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (tasks[taskHash].status != Status.None) revert InvalidStatus(tasks[taskHash].status, Status.None);

        tasks[taskHash] = Task({
            buyer: msg.sender,
            worker: address(0),
            token: token,
            verifier: address(0),
            amount: amount,
            deadline: deadline,
            resultHash: bytes32(0),
            status: Status.Funded
        });

        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(taskHash, msg.sender, token, amount, deadline);
    }

    function claim(bytes32 taskHash) external {
        Task storage task = tasks[taskHash];
        if (task.status != Status.Funded) revert InvalidStatus(task.status, Status.Funded);
        if (block.timestamp >= task.deadline) revert InvalidDeadline();

        task.worker = msg.sender;
        task.status = Status.Claimed;
        emit Claimed(taskHash, msg.sender);
    }

    function attest(bytes32 taskHash, bytes32 resultHash, bool passed) external onlyVerifier {
        Task storage task = tasks[taskHash];
        if (task.status != Status.Claimed) revert InvalidStatus(task.status, Status.Claimed);
        if (task.worker == address(0)) revert MissingWorker();
        if (resultHash == bytes32(0)) revert InvalidTaskHash();

        task.verifier = msg.sender;
        task.resultHash = resultHash;
        task.status = passed ? Status.Passed : Status.Failed;
        emit Attested(taskHash, msg.sender, resultHash, passed);
    }

    function release(bytes32 taskHash) public nonReentrant {
        Task storage task = tasks[taskHash];
        if (task.status != Status.Passed) revert InvalidStatus(task.status, Status.Passed);
        if (task.worker == address(0)) revert MissingWorker();
        _release(taskHash, task);
    }

    function refund(bytes32 taskHash) public nonReentrant {
        Task storage task = tasks[taskHash];
        bool buyerRefund = msg.sender == task.buyer && (task.status == Status.Funded || task.status == Status.Failed);
        bool timeoutRefund = block.timestamp >= task.deadline && (task.status == Status.Funded || task.status == Status.Claimed);
        if (!buyerRefund && !timeoutRefund) {
            if (task.status == Status.Funded) revert DeadlineNotReached();
            revert InvalidStatus(task.status, Status.Funded);
        }

        _refund(taskHash, task);
    }

    function openDispute(bytes32 taskHash) external {
        Task storage task = tasks[taskHash];
        if (msg.sender != task.buyer && msg.sender != task.worker) revert NotParticipant();
        if (task.status != Status.Passed && task.status != Status.Failed) {
            revert InvalidStatus(task.status, Status.Passed);
        }

        task.status = Status.Disputed;
        emit Disputed(taskHash, msg.sender);
    }

    function resolveDispute(bytes32 taskHash, bool releaseToWorker) external onlyOwner {
        Task storage task = tasks[taskHash];
        if (task.status != Status.Disputed) revert InvalidStatus(task.status, Status.Disputed);

        emit DisputeResolved(taskHash, releaseToWorker);
        if (releaseToWorker) {
            if (task.worker == address(0)) revert MissingWorker();
            _release(taskHash, task);
        } else {
            _refund(taskHash, task);
        }
    }

    function getTask(bytes32 taskHash) external view returns (Task memory) {
        return tasks[taskHash];
    }

    function _release(bytes32 taskHash, Task storage task) internal {
        task.status = Status.Released;
        if (!IERC20(task.token).transfer(task.worker, task.amount)) revert TransferFailed();
        emit Released(taskHash, task.worker, task.amount);
    }

    function _refund(bytes32 taskHash, Task storage task) internal {
        task.status = Status.Refunded;
        if (!IERC20(task.token).transfer(task.buyer, task.amount)) revert TransferFailed();
        emit Refunded(taskHash, task.buyer, task.amount);
    }
}
